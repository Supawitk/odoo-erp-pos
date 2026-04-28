import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lt } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Sales Insights aggregator.
 *
 * Returns four cuts of POS data over a [from, to) window, all derived from
 * pos_orders (the operational source of truth). Pure read aggregation; no
 * side effects.
 *
 *   - paymentMix:       count + revenue per paymentMethod (cash / card / promptpay / split)
 *   - hourlyHeatmap:    7×24 grid of orderCount, weekday-indexed (Mon=0…Sun=6) in Asia/Bangkok
 *   - documentMix:      count + revenue per documentType — TX/ABB/RE compliance signal,
 *                       CN reported separately as the refund column
 *   - periodCompare:    same-window vs immediately preceding window of equal length
 *                       (last 7 days vs prior 7 days at the default cadence)
 *
 * The window defaults to the last 30 days when from/to are omitted.
 * Refunded orders count toward refundedRevenue; CN documents count toward
 * documentMix.CN but their revenue is added with the same sign the row carries
 * in the DB (already negative).
 */
export interface PaymentMixRow {
  method: string;
  orderCount: number;
  revenueCents: number;
}

export interface HourlyHeatmapCell {
  weekday: number; // 0=Mon … 6=Sun
  hour: number;    // 0..23
  orderCount: number;
  revenueCents: number;
}

export interface DocumentMixRow {
  documentType: 'RE' | 'ABB' | 'TX' | 'CN' | string;
  orderCount: number;
  revenueCents: number;
}

export interface PeriodCompare {
  current: { from: string; to: string; orderCount: number; revenueCents: number };
  previous: { from: string; to: string; orderCount: number; revenueCents: number };
  deltaPct: number; // (current - previous) / previous, 0 when previous = 0
}

export interface InsightsReport {
  window: { fromIso: string; toIso: string; days: number };
  paymentMix: PaymentMixRow[];
  hourlyHeatmap: HourlyHeatmapCell[];
  documentMix: DocumentMixRow[];
  periodCompare: PeriodCompare;
  refundCount: number;
  refundedRevenueCents: number;
}

@Injectable()
export class InsightsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string }): Promise<InsightsReport> {
    const to = opts.toIso ? new Date(opts.toIso) : new Date();
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const windowMs = to.getTime() - from.getTime();
    const days = Math.max(1, Math.round(windowMs / (24 * 60 * 60 * 1000)));

    const rows = await this.db
      .select({
        createdAt: posOrders.createdAt,
        paymentMethod: posOrders.paymentMethod,
        documentType: posOrders.documentType,
        totalCents: posOrders.totalCents,
        status: posOrders.status,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)));

    // Payment mix
    const payMap = new Map<string, { orderCount: number; revenueCents: number }>();
    let refundCount = 0;
    let refundedRevenueCents = 0;
    for (const r of rows) {
      const key = r.paymentMethod;
      const cur = payMap.get(key) ?? { orderCount: 0, revenueCents: 0 };
      cur.orderCount += 1;
      cur.revenueCents += Number(r.totalCents);
      payMap.set(key, cur);
      // Refund metric counts CN documents only — the original (now status=refunded)
      // would double-count the same physical refund event.
      if (r.documentType === 'CN') {
        refundCount += 1;
        refundedRevenueCents += Number(r.totalCents);
      }
    }
    const paymentMix: PaymentMixRow[] = [...payMap.entries()]
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.revenueCents - a.revenueCents);

    // Hourly heatmap in Asia/Bangkok. Mon=0, Sun=6.
    // We construct the cell key from the local-time wall clock; doing this in JS
    // is fine for our scale (well under 100k rows per window).
    const heatMap = new Map<string, HourlyHeatmapCell>();
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
    });
    const weekdayIdx: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    for (const r of rows) {
      if (!r.createdAt) continue;
      const parts = fmt.formatToParts(r.createdAt as Date);
      const wkPart = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
      const hrPart = parts.find((p) => p.type === 'hour')?.value ?? '00';
      const wk = weekdayIdx[wkPart] ?? 0;
      const hr = Number(hrPart) % 24;
      const key = `${wk}_${hr}`;
      const cur =
        heatMap.get(key) ?? { weekday: wk, hour: hr, orderCount: 0, revenueCents: 0 };
      cur.orderCount += 1;
      cur.revenueCents += Number(r.totalCents);
      heatMap.set(key, cur);
    }
    const hourlyHeatmap = [...heatMap.values()].sort(
      (a, b) => a.weekday - b.weekday || a.hour - b.hour,
    );

    // Document mix (compliance signal: TX vs ABB vs RE)
    const docMap = new Map<string, { orderCount: number; revenueCents: number }>();
    for (const r of rows) {
      const key = r.documentType ?? 'RE';
      const cur = docMap.get(key) ?? { orderCount: 0, revenueCents: 0 };
      cur.orderCount += 1;
      cur.revenueCents += Number(r.totalCents);
      docMap.set(key, cur);
    }
    const documentMix: DocumentMixRow[] = [...docMap.entries()]
      .map(([documentType, v]) => ({ documentType, ...v }))
      .sort((a, b) => b.orderCount - a.orderCount);

    // Period comparison — preceding equal-length window
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - windowMs);
    const prevRows = await this.db
      .select({
        totalCents: posOrders.totalCents,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, prevFrom), lt(posOrders.createdAt, prevTo)));

    const currentRevenue = rows.reduce((s, r) => s + Number(r.totalCents), 0);
    const previousRevenue = prevRows.reduce((s, r) => s + Number(r.totalCents), 0);
    const deltaPct = previousRevenue === 0 ? 0 : (currentRevenue - previousRevenue) / previousRevenue;

    return {
      window: { fromIso: from.toISOString(), toIso: to.toISOString(), days },
      paymentMix,
      hourlyHeatmap,
      documentMix,
      periodCompare: {
        current: {
          from: from.toISOString(),
          to: to.toISOString(),
          orderCount: rows.length,
          revenueCents: currentRevenue,
        },
        previous: {
          from: prevFrom.toISOString(),
          to: prevTo.toISOString(),
          orderCount: prevRows.length,
          revenueCents: previousRevenue,
        },
        deltaPct,
      },
      refundCount,
      refundedRevenueCents,
    };
  }
}
