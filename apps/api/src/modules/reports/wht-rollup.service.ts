import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * 🇹🇭 Withholding Tax (ภาษีหัก ณ ที่จ่าย) roll-up.
 *
 * Two sides:
 *   - PAID by us: every bill_payment with wht_cents > 0. We deducted from the
 *     supplier and owe RD on their behalf via PND.3 / PND.53. 50-Tawi cert is
 *     issued at this point.
 *   - RECEIVED from us: every invoice_receipt with wht_cents > 0. The customer
 *     deducted from our invoice; we'll claim it back on PND.50 at year-end.
 *
 * Aggregated by calendar month (Asia/Bangkok) within the window.
 */

export interface WhtMonthRow {
  month: string; // YYYY-MM
  paidCents: number;
  paidCount: number;
  receivedCents: number;
  receivedCount: number;
}

export interface WhtRollupReport {
  fromIso: string;
  toIso: string;
  totals: {
    paidCents: number;
    paidCount: number;
    receivedCents: number;
    receivedCount: number;
  };
  byMonth: WhtMonthRow[];
}

@Injectable()
export class WhtRollupService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<WhtRollupReport> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const rows = await this.db.execute<{
      month: string;
      paid_cents: number;
      paid_count: number;
      received_cents: number;
      received_count: number;
    }>(sql`
      WITH paid AS (
        SELECT
          to_char(date_trunc('month', payment_date), 'YYYY-MM') AS month,
          COUNT(*)::int AS cnt,
          COALESCE(SUM(wht_cents), 0)::bigint AS amt
        FROM custom.bill_payments
        WHERE payment_date >= ${from.toISOString().slice(0, 10)}::date
          AND payment_date <  ${to.toISOString().slice(0, 10)}::date
          AND voided_at IS NULL
          AND wht_cents > 0
        GROUP BY 1
      ),
      received AS (
        SELECT
          to_char(date_trunc('month', receipt_date), 'YYYY-MM') AS month,
          COUNT(*)::int AS cnt,
          COALESCE(SUM(wht_cents), 0)::bigint AS amt
        FROM custom.invoice_receipts
        WHERE receipt_date >= ${from.toISOString().slice(0, 10)}::date
          AND receipt_date <  ${to.toISOString().slice(0, 10)}::date
          AND voided_at IS NULL
          AND wht_cents > 0
        GROUP BY 1
      ),
      months AS (
        SELECT month FROM paid
        UNION
        SELECT month FROM received
      )
      SELECT
        m.month,
        COALESCE(p.amt, 0)::bigint   AS paid_cents,
        COALESCE(p.cnt, 0)::int      AS paid_count,
        COALESCE(r.amt, 0)::bigint   AS received_cents,
        COALESCE(r.cnt, 0)::int      AS received_count
      FROM months m
      LEFT JOIN paid p     ON p.month = m.month
      LEFT JOIN received r ON r.month = m.month
      ORDER BY m.month
    `).then((res: any) => (res.rows ?? res ?? []) as any[]);

    const totals = rows.reduce(
      (acc, r) => {
        acc.paidCents += Number(r.paid_cents ?? 0);
        acc.paidCount += Number(r.paid_count ?? 0);
        acc.receivedCents += Number(r.received_cents ?? 0);
        acc.receivedCount += Number(r.received_count ?? 0);
        return acc;
      },
      { paidCents: 0, paidCount: 0, receivedCents: 0, receivedCount: 0 },
    );

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      totals,
      byMonth: rows.map((r) => ({
        month: r.month,
        paidCents: Number(r.paid_cents ?? 0),
        paidCount: Number(r.paid_count ?? 0),
        receivedCents: Number(r.received_cents ?? 0),
        receivedCount: Number(r.received_count ?? 0),
      })),
    };
  }
}
