import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { partners, salesInvoices, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * AR aging — what customers owe us, bucketed by how overdue each invoice is.
 *
 * Bucketing rule (mirrors AP aging):
 *   effectiveDueDate = invoice.dueDate ?? (invoiceDate + paymentTermsDays)
 *   daysOverdue      = max(0, asOf − effectiveDueDate)
 *
 * Buckets:
 *   current   — not yet due (daysOverdue == 0)
 *   d1_30     — 1..30 days overdue
 *   d31_60    — 31..60
 *   d61_90    — 61..90
 *   d90_plus  — 90+
 *
 * Only `sent` and `partially_paid` invoices carry an open balance.
 * `paid`, `cancelled`, `draft` are excluded.
 */

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface CustomerAging {
  customerId: string;
  customerName: string;
  totalRemainingCents: number;
  buckets: Record<AgingBucket, number>;
  invoices: Array<{
    invoiceId: string;
    internalNumber: string;
    invoiceDate: string;
    dueDate: string | null;
    effectiveDueDate: string;
    daysOverdue: number;
    bucket: AgingBucket;
    totalCents: number;
    paidCents: number;
    remainingCents: number;
    whtCents: number;
    whtReceivedCents: number;
    status: string;
  }>;
}

export interface ArAgingReport {
  asOfDate: string;
  grandTotalCents: number;
  bucketTotals: Record<AgingBucket, number>;
  customers: CustomerAging[];
}

@Injectable()
export class ArAgingService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { asOf?: string; customerId?: string } = {}): Promise<ArAgingReport> {
    const asOfDate = opts.asOf ?? new Date().toISOString().slice(0, 10);

    const where = [
      inArray(salesInvoices.status, ['sent', 'partially_paid']),
    ] as any[];
    if (opts.customerId) where.push(eq(salesInvoices.customerId, opts.customerId));

    const rows = await this.db
      .select({
        id: salesInvoices.id,
        internalNumber: salesInvoices.internalNumber,
        customerId: salesInvoices.customerId,
        customerName: partners.name,
        paymentTermsDays: salesInvoices.paymentTermsDays,
        invoiceDate: salesInvoices.invoiceDate,
        dueDate: salesInvoices.dueDate,
        totalCents: salesInvoices.totalCents,
        paidCents: salesInvoices.paidCents,
        whtCents: salesInvoices.whtCents,
        whtReceivedCents: salesInvoices.whtReceivedCents,
        status: salesInvoices.status,
      })
      .from(salesInvoices)
      .leftJoin(partners, eq(partners.id, salesInvoices.customerId))
      .where(and(...where))
      .orderBy(desc(salesInvoices.invoiceDate));

    const grouped = new Map<string, CustomerAging>();
    const bucketTotals: Record<AgingBucket, number> = {
      current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0,
    };
    let grand = 0;

    for (const r of rows) {
      const total = Number(r.totalCents);
      const paid = Number(r.paidCents ?? 0);
      const remaining = total - paid;
      if (remaining <= 0) continue;

      const effectiveDueDate = effectiveDue(
        String(r.invoiceDate),
        r.dueDate ? String(r.dueDate) : null,
        Number(r.paymentTermsDays ?? 30),
      );
      const daysOverdue = daysBetween(effectiveDueDate, asOfDate);
      const bucket = pickBucket(daysOverdue);

      bucketTotals[bucket] += remaining;
      grand += remaining;

      const customerId = r.customerId;
      let agg = grouped.get(customerId);
      if (!agg) {
        agg = {
          customerId,
          customerName: r.customerName ?? '(unknown)',
          totalRemainingCents: 0,
          buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
          invoices: [],
        };
        grouped.set(customerId, agg);
      }
      agg.totalRemainingCents += remaining;
      agg.buckets[bucket] += remaining;
      agg.invoices.push({
        invoiceId: r.id,
        internalNumber: r.internalNumber,
        invoiceDate: String(r.invoiceDate),
        dueDate: r.dueDate ? String(r.dueDate) : null,
        effectiveDueDate,
        daysOverdue,
        bucket,
        totalCents: total,
        paidCents: paid,
        remainingCents: remaining,
        whtCents: Number(r.whtCents),
        whtReceivedCents: Number(r.whtReceivedCents ?? 0),
        status: r.status,
      });
    }

    const customers = Array.from(grouped.values()).sort(
      (a, b) => b.totalRemainingCents - a.totalRemainingCents,
    );
    return { asOfDate, grandTotalCents: grand, bucketTotals, customers };
  }
}

export function effectiveDue(
  invoiceDate: string,
  dueDate: string | null,
  paymentTermsDays: number,
): string {
  if (dueDate) return dueDate;
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + paymentTermsDays);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromDate: string, toDate: string): number {
  const a = new Date(`${fromDate}T00:00:00Z`).getTime();
  const b = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((b - a) / 86400000));
}

export function pickBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}
