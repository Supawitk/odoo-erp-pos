import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { vendorBills, partners, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Three-way-match exceptions: bills that haven't been reconciled to a PO+GRN.
 *
 * Two states count as exceptions:
 *   - match_status IS NULL  (never run through matching, e.g. ad-hoc bills)
 *   - match_status != 'matched' AND != NULL (e.g. variance, missing GRN)
 *
 * Voided bills are excluded — they don't matter for risk roll-up.
 */
export interface MatchExceptionsReport {
  asOfIso: string;
  unmatched: {
    count: number;
    totalCents: number;
  };
  byStatus: Array<{
    status: string; // 'unmatched' | 'variance' | 'missing_po' | 'missing_grn' | etc
    count: number;
    totalCents: number;
  }>;
  topBills: Array<{
    billId: string;
    internalNumber: string;
    supplierName: string;
    matchStatus: string | null;
    billStatus: string;
    totalCents: number;
    billDate: string;
  }>;
}

@Injectable()
export class MatchExceptionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(): Promise<MatchExceptionsReport> {
    // Anything not 'matched' (and not voided) is an exception.
    const exceptionPredicate = sql`(
      ${vendorBills.matchStatus} IS NULL
      OR ${vendorBills.matchStatus} <> 'matched'
    ) AND ${vendorBills.status} <> 'void'`;

    const [totalsRow] = await this.db
      .select({
        count: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${vendorBills.totalCents}), 0)::bigint`,
      })
      .from(vendorBills)
      .where(exceptionPredicate);

    const byStatusRows = await this.db
      .select({
        status: sql<string>`COALESCE(${vendorBills.matchStatus}, 'unmatched')`,
        count: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${vendorBills.totalCents}), 0)::bigint`,
      })
      .from(vendorBills)
      .where(exceptionPredicate)
      .groupBy(sql`COALESCE(${vendorBills.matchStatus}, 'unmatched')`)
      .orderBy(desc(sql`COALESCE(SUM(${vendorBills.totalCents}), 0)`));

    const topRows = await this.db
      .select({
        billId: vendorBills.id,
        internalNumber: vendorBills.internalNumber,
        supplierName: partners.name,
        matchStatus: vendorBills.matchStatus,
        billStatus: vendorBills.status,
        totalCents: vendorBills.totalCents,
        billDate: vendorBills.billDate,
      })
      .from(vendorBills)
      .leftJoin(partners, eq(partners.id, vendorBills.supplierId))
      .where(exceptionPredicate)
      .orderBy(desc(vendorBills.totalCents))
      .limit(5);

    return {
      asOfIso: new Date().toISOString(),
      unmatched: {
        count: totalsRow?.count ?? 0,
        totalCents: Number(totalsRow?.totalCents ?? 0),
      },
      byStatus: byStatusRows.map((r) => ({
        status: r.status,
        count: Number(r.count),
        totalCents: Number(r.totalCents),
      })),
      topBills: topRows.map((r) => ({
        billId: r.billId,
        internalNumber: r.internalNumber,
        supplierName: r.supplierName ?? '—',
        matchStatus: r.matchStatus,
        billStatus: r.billStatus,
        totalCents: Number(r.totalCents),
        billDate: r.billDate,
      })),
    };
  }
}
