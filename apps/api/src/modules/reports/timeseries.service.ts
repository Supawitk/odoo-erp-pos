import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lt } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

export type Granularity = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface TimeseriesBucket {
  key: string;            // 2026-04-21 / 2026-04 / 2026-Q2 / 2026
  label: string;          // human-friendly short label
  startIso: string;       // bucket start (UTC ISO)
  revenueCents: number;
  orderCount: number;
  refundCents: number;    // negative
  refundCount: number;
  vatCents: number;       // sum of vat_breakdown.totalVatCents (best-effort)
  byDocType: Record<'RE' | 'ABB' | 'TX' | 'CN', number>;
  byPayment: Record<string, number>;
}

export interface TimeseriesResponse {
  granularity: Granularity;
  fromIso: string;
  toIso: string;
  buckets: TimeseriesBucket[];
  totals: {
    revenueCents: number;
    orderCount: number;
    refundCount: number;
    refundCents: number;
    vatCents: number;
    aovCents: number;
    refundRate: number;   // refundCount / orderCount, 0..1
  };
}

const TZ = 'Asia/Bangkok';

@Injectable()
export class TimeseriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: {
    fromIso: string;
    toIso: string;
    granularity: Granularity;
  }): Promise<TimeseriesResponse> {
    const from = new Date(opts.fromIso);
    const to = new Date(opts.toIso);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new Error('Invalid window — from must precede to and both must be valid ISO');
    }

    const rows = await this.db
      .select({
        createdAt: posOrders.createdAt,
        totalCents: posOrders.totalCents,
        documentType: posOrders.documentType,
        paymentMethod: posOrders.paymentMethod,
        vatBreakdown: posOrders.vatBreakdown,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)));

    // Pre-create empty buckets so the chart has zero-rows for quiet periods.
    const buckets = new Map<string, TimeseriesBucket>();
    for (const k of generateBucketKeys(from, to, opts.granularity)) {
      buckets.set(k.key, {
        key: k.key,
        label: k.label,
        startIso: k.start.toISOString(),
        revenueCents: 0,
        orderCount: 0,
        refundCents: 0,
        refundCount: 0,
        vatCents: 0,
        byDocType: { RE: 0, ABB: 0, TX: 0, CN: 0 },
        byPayment: {},
      });
    }

    let totalRevenue = 0;
    let totalOrders = 0;
    let totalRefundCount = 0;
    let totalRefundCents = 0;
    let totalVat = 0;

    for (const r of rows) {
      if (!r.createdAt) continue;
      const k = bucketKeyFor(r.createdAt as Date, opts.granularity);
      const b =
        buckets.get(k.key) ??
        ({
          key: k.key,
          label: k.label,
          startIso: k.start.toISOString(),
          revenueCents: 0,
          orderCount: 0,
          refundCents: 0,
          refundCount: 0,
          vatCents: 0,
          byDocType: { RE: 0, ABB: 0, TX: 0, CN: 0 },
          byPayment: {},
        } as TimeseriesBucket);

      const cents = Number(r.totalCents);
      b.revenueCents += cents;
      b.orderCount += 1;
      const dt = (r.documentType ?? 'RE') as keyof TimeseriesBucket['byDocType'];
      if (dt === 'RE' || dt === 'ABB' || dt === 'TX' || dt === 'CN') {
        b.byDocType[dt] += 1;
      }
      const pay = r.paymentMethod ?? 'unknown';
      b.byPayment[pay] = (b.byPayment[pay] ?? 0) + 1;
      if (r.documentType === 'CN') {
        b.refundCount += 1;
        b.refundCents += cents; // already negative on CN rows
        totalRefundCount += 1;
        totalRefundCents += cents;
      }

      // VAT — best-effort from vat_breakdown jsonb
      const vat = parseVat(r.vatBreakdown);
      b.vatCents += vat;
      totalVat += vat;

      buckets.set(k.key, b);
      totalRevenue += cents;
      totalOrders += 1;
    }

    const ordered = [...buckets.values()].sort((a, b) =>
      a.startIso.localeCompare(b.startIso),
    );
    const aov = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const refundRate = totalOrders > 0 ? totalRefundCount / totalOrders : 0;
    return {
      granularity: opts.granularity,
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      buckets: ordered,
      totals: {
        revenueCents: totalRevenue,
        orderCount: totalOrders,
        refundCount: totalRefundCount,
        refundCents: totalRefundCents,
        vatCents: totalVat,
        aovCents: aov,
        refundRate,
      },
    };
  }
}

// vat_breakdown shape varies; we accept either {totalVatCents} or array of lines.
function parseVat(v: unknown): number {
  if (!v) return 0;
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.totalVatCents === 'number') return obj.totalVatCents;
    if (typeof obj.vatCents === 'number') return obj.vatCents;
    if (Array.isArray(obj.lines)) {
      return obj.lines.reduce(
        (s: number, l: any) => s + (Number(l?.vatCents) || 0),
        0,
      );
    }
  }
  return 0;
}

interface BucketKey {
  key: string;
  label: string;
  start: Date;
}

function bucketKeyFor(d: Date, g: Granularity): BucketKey {
  const partsTH = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of partsTH) lookup[p.type] = p.value;
  const Y = lookup.year, M = lookup.month, D = lookup.day, H = lookup.hour;
  const ymd = `${Y}-${M}-${D}`;

  if (g === 'hour') {
    const start = new Date(`${ymd}T${H}:00:00+07:00`);
    return { key: `${ymd} ${H}`, label: `${H}:00`, start };
  }
  if (g === 'day') {
    const start = new Date(`${ymd}T00:00:00+07:00`);
    return { key: ymd, label: `${M}-${D}`, start };
  }
  if (g === 'week') {
    // ISO Monday-start week; compute via JS Date in BKK
    const start = mondayOfWeekTH(new Date(`${ymd}T12:00:00+07:00`));
    const startStr = isoLocalDate(start);
    return { key: `${startStr}/W`, label: startStr.slice(5), start };
  }
  if (g === 'month') {
    const start = new Date(`${Y}-${M}-01T00:00:00+07:00`);
    return { key: `${Y}-${M}`, label: `${Y}-${M}`, start };
  }
  if (g === 'quarter') {
    const m = Number(M);
    const q = Math.floor((m - 1) / 3) + 1;
    const monthStart = String((q - 1) * 3 + 1).padStart(2, '0');
    const start = new Date(`${Y}-${monthStart}-01T00:00:00+07:00`);
    return { key: `${Y}-Q${q}`, label: `${Y} Q${q}`, start };
  }
  // year
  const start = new Date(`${Y}-01-01T00:00:00+07:00`);
  return { key: `${Y}`, label: Y, start };
}

function isoLocalDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function mondayOfWeekTH(d: Date): Date {
  const wkPart = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
  })
    .formatToParts(d)
    .find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const map: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const offset = map[wkPart] ?? 0;
  const local = new Date(d.getTime() - offset * 24 * 60 * 60 * 1000);
  return new Date(`${isoLocalDate(local)}T00:00:00+07:00`);
}

function* generateBucketKeys(
  from: Date,
  to: Date,
  g: Granularity,
): Generator<BucketKey> {
  const bk = bucketKeyFor(from, g);
  let cursor = bk.start;
  let last = '';
  while (cursor < to) {
    const k = bucketKeyFor(cursor, g);
    if (k.key !== last) {
      yield k;
      last = k.key;
    }
    cursor = advance(cursor, g);
  }
}

function advance(d: Date, g: Granularity): Date {
  const next = new Date(d.getTime());
  switch (g) {
    case 'hour':
      next.setUTCHours(next.getUTCHours() + 1);
      break;
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
    case 'quarter':
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
  }
  return next;
}
