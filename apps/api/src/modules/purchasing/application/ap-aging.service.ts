import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { partners, vendorBills, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * AP aging — what we owe suppliers, bucketed by how overdue each bill is.
 *
 * Bucketing rule: pick the bill's effective due date as
 *   dueDate ?? (billDate + supplier.paymentTermsDays)
 * Then daysOverdue = max(0, asOf − effectiveDueDate).
 *
 * Buckets:
 *   current   — not yet due (daysOverdue == 0)
 *   d1_30     — 1..30 days overdue
 *   d31_60    — 31..60
 *   d61_90    — 61..90
 *   d90_plus  — 90+
 *
 * Only `posted` and `partially_paid` bills carry an open balance. `paid` and
 * `void` are excluded — they have nothing left to age.
 */

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface SupplierAging {
  supplierId: string;
  supplierName: string;
  totalRemainingCents: number;
  buckets: Record<AgingBucket, number>;
  bills: Array<{
    billId: string;
    internalNumber: string;
    billDate: string;
    dueDate: string | null;
    effectiveDueDate: string;
    daysOverdue: number;
    bucket: AgingBucket;
    totalCents: number;
    paidCents: number;
    remainingCents: number;
    whtCents: number;
    whtPaidCents: number;
    status: string;
  }>;
}

export interface AgingReport {
  asOfDate: string;
  grandTotalCents: number;
  bucketTotals: Record<AgingBucket, number>;
  suppliers: SupplierAging[];
}

@Injectable()
export class ApAgingService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { asOf?: string; supplierId?: string } = {}): Promise<AgingReport> {
    const asOfDate = opts.asOf ?? new Date().toISOString().slice(0, 10);

    const where = [
      inArray(vendorBills.status, ['posted', 'partially_paid']),
    ] as any[];
    if (opts.supplierId) where.push(eq(vendorBills.supplierId, opts.supplierId));

    const rows = await this.db
      .select({
        id: vendorBills.id,
        internalNumber: vendorBills.internalNumber,
        supplierId: vendorBills.supplierId,
        supplierName: partners.name,
        paymentTermsDays: partners.paymentTermsDays,
        billDate: vendorBills.billDate,
        dueDate: vendorBills.dueDate,
        totalCents: vendorBills.totalCents,
        paidCents: vendorBills.paidCents,
        whtCents: vendorBills.whtCents,
        whtPaidCents: vendorBills.whtPaidCents,
        status: vendorBills.status,
      })
      .from(vendorBills)
      .leftJoin(partners, eq(partners.id, vendorBills.supplierId))
      .where(and(...where))
      .orderBy(desc(vendorBills.billDate));

    const grouped = new Map<string, SupplierAging>();
    const bucketTotals: Record<AgingBucket, number> = {
      current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0,
    };
    let grand = 0;

    for (const r of rows) {
      const total = Number(r.totalCents);
      const paid = Number(r.paidCents ?? 0);
      const remaining = total - paid;
      if (remaining <= 0) continue; // safety — shouldn't happen for posted/partial

      const effectiveDueDate = effectiveDue(
        String(r.billDate),
        r.dueDate ? String(r.dueDate) : null,
        Number(r.paymentTermsDays ?? 30),
      );
      const daysOverdue = daysBetween(effectiveDueDate, asOfDate);
      const bucket = pickBucket(daysOverdue);

      bucketTotals[bucket] += remaining;
      grand += remaining;

      const supplierId = r.supplierId;
      let agg = grouped.get(supplierId);
      if (!agg) {
        agg = {
          supplierId,
          supplierName: r.supplierName ?? '(unknown)',
          totalRemainingCents: 0,
          buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
          bills: [],
        };
        grouped.set(supplierId, agg);
      }
      agg.totalRemainingCents += remaining;
      agg.buckets[bucket] += remaining;
      agg.bills.push({
        billId: r.id,
        internalNumber: r.internalNumber,
        billDate: String(r.billDate),
        dueDate: r.dueDate ? String(r.dueDate) : null,
        effectiveDueDate,
        daysOverdue,
        bucket,
        totalCents: total,
        paidCents: paid,
        remainingCents: remaining,
        whtCents: Number(r.whtCents),
        whtPaidCents: Number(r.whtPaidCents ?? 0),
        status: r.status,
      });
    }

    const suppliers = Array.from(grouped.values()).sort(
      (a, b) => b.totalRemainingCents - a.totalRemainingCents,
    );
    return { asOfDate, grandTotalCents: grand, bucketTotals, suppliers };
  }
}

/** Bills shipped without explicit dueDate fall back to billDate + paymentTermsDays. */
export function effectiveDue(
  billDate: string,
  dueDate: string | null,
  paymentTermsDays: number,
): string {
  if (dueDate) return dueDate;
  const d = new Date(`${billDate}T00:00:00Z`);
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
