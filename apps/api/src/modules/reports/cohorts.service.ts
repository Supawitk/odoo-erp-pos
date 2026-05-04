import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Customer cohort + retention.
 *
 * For the requested window:
 *   - Identify each "customer" by buyer_tin (NULL TIN = walk-in, aggregated as
 *     a single anonymous bucket and excluded from the cohort math).
 *   - For each identified customer in the window, find their EVER first-order
 *     date across all time → assigns a cohort.
 *   - Cohort key = YYYY-MM of first order.
 *   - "New in window" = cohort month falls inside [from, to). "Returning" =
 *     they ordered before [from, to) and again inside it.
 *
 * Returns:
 *   - new vs returning counts + revenue (in window)
 *   - cohort table: rows = first-order month, cols = month-since-first,
 *     value = customers active that month + revenue.
 */

export interface CohortCell {
  cohortMonth: string;          // YYYY-MM
  monthOffset: number;          // 0 = first month, 1 = next, ...
  activeCustomers: number;
  revenueCents: number;
}

export interface CohortReport {
  fromIso: string;
  toIso: string;
  inWindow: {
    identifiedCustomers: number;
    walkInOrderCount: number;
    walkInRevenueCents: number;
    newCustomers: number;
    returningCustomers: number;
    newRevenueCents: number;
    returningRevenueCents: number;
  };
  cohorts: Array<{
    cohortMonth: string;
    cohortSize: number;
    cells: CohortCell[];
  }>;
}

@Injectable()
export class CohortsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<CohortReport> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // ── Walk-in totals + identified-customer totals in window
    const [w] = await this.db.execute<{
      walk_in_orders: number;
      walk_in_revenue: number;
      identified_orders: number;
      identified_revenue: number;
      identified_customers: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE buyer_tin IS NULL OR buyer_tin = '')::int                     AS walk_in_orders,
        COALESCE(SUM(total_cents) FILTER (WHERE buyer_tin IS NULL OR buyer_tin = ''), 0)::bigint
                                                                                              AS walk_in_revenue,
        COUNT(*) FILTER (WHERE buyer_tin IS NOT NULL AND buyer_tin <> '')::int               AS identified_orders,
        COALESCE(SUM(total_cents) FILTER (WHERE buyer_tin IS NOT NULL AND buyer_tin <> ''), 0)::bigint
                                                                                              AS identified_revenue,
        COUNT(DISTINCT buyer_tin) FILTER (WHERE buyer_tin IS NOT NULL AND buyer_tin <> '')::int
                                                                                              AS identified_customers
      FROM custom.pos_orders
      WHERE created_at >= ${from.toISOString()}::timestamptz
        AND created_at <  ${to.toISOString()}::timestamptz
    `).then((res: any) => (res.rows ?? res ?? [{}]) as any[]);

    // ── New vs returning split
    const [nr] = await this.db.execute<{
      new_customers: number;
      new_revenue: number;
      returning_customers: number;
      returning_revenue: number;
    }>(sql`
      WITH first_seen AS (
        SELECT buyer_tin, MIN(created_at) AS first_order_at
        FROM custom.pos_orders
        WHERE buyer_tin IS NOT NULL AND buyer_tin <> ''
        GROUP BY buyer_tin
      ),
      window_rev AS (
        SELECT o.buyer_tin, SUM(o.total_cents) AS rev
        FROM custom.pos_orders o
        WHERE o.created_at >= ${from.toISOString()}::timestamptz
          AND o.created_at <  ${to.toISOString()}::timestamptz
          AND o.buyer_tin IS NOT NULL AND o.buyer_tin <> ''
        GROUP BY o.buyer_tin
      )
      SELECT
        COUNT(*) FILTER (WHERE fs.first_order_at >= ${from.toISOString()}::timestamptz)::int AS new_customers,
        COALESCE(SUM(wr.rev) FILTER (WHERE fs.first_order_at >= ${from.toISOString()}::timestamptz), 0)::bigint AS new_revenue,
        COUNT(*) FILTER (WHERE fs.first_order_at <  ${from.toISOString()}::timestamptz)::int AS returning_customers,
        COALESCE(SUM(wr.rev) FILTER (WHERE fs.first_order_at <  ${from.toISOString()}::timestamptz), 0)::bigint AS returning_revenue
      FROM window_rev wr
      JOIN first_seen fs USING (buyer_tin)
    `).then((res: any) => (res.rows ?? res ?? [{}]) as any[]);

    // ── Cohort table (ALL TIME — small table). Filtered to cohorts whose
    // first month is within last 12 months so the response stays small.
    const cohortRows = await this.db.execute<{
      cohort_month: string;
      activity_month: string;
      active_customers: number;
      revenue_cents: number;
    }>(sql`
      WITH first_seen AS (
        SELECT buyer_tin, date_trunc('month', MIN(created_at) AT TIME ZONE 'Asia/Bangkok') AS cohort_dt
        FROM custom.pos_orders
        WHERE buyer_tin IS NOT NULL AND buyer_tin <> ''
        GROUP BY buyer_tin
      ),
      orders_with_cohort AS (
        SELECT
          fs.cohort_dt,
          date_trunc('month', o.created_at AT TIME ZONE 'Asia/Bangkok') AS activity_dt,
          o.buyer_tin,
          o.total_cents
        FROM custom.pos_orders o
        JOIN first_seen fs USING (buyer_tin)
        WHERE fs.cohort_dt >= (now() - interval '12 months')
      )
      SELECT
        to_char(cohort_dt, 'YYYY-MM')                  AS cohort_month,
        to_char(activity_dt, 'YYYY-MM')                AS activity_month,
        COUNT(DISTINCT buyer_tin)::int                 AS active_customers,
        COALESCE(SUM(total_cents), 0)::bigint          AS revenue_cents
      FROM orders_with_cohort
      GROUP BY 1, 2
      ORDER BY 1, 2
    `).then((res: any) => (res.rows ?? res ?? []) as any[]);

    // Group into the per-cohort structure with monthOffset.
    const monthsBetween = (a: string, b: string) => {
      const [ay, am] = a.split('-').map(Number);
      const [by, bm] = b.split('-').map(Number);
      return (by - ay) * 12 + (bm - am);
    };
    const cohortMap = new Map<string, { size: number; cells: CohortCell[] }>();
    for (const r of cohortRows) {
      const key = r.cohort_month;
      const c =
        cohortMap.get(key) ?? { size: 0, cells: [] as CohortCell[] };
      c.cells.push({
        cohortMonth: r.cohort_month,
        monthOffset: monthsBetween(r.cohort_month, r.activity_month),
        activeCustomers: Number(r.active_customers ?? 0),
        revenueCents: Number(r.revenue_cents ?? 0),
      });
      cohortMap.set(key, c);
    }
    // size = customers active in offset 0
    for (const [, v] of cohortMap) {
      v.size = v.cells.find((c) => c.monthOffset === 0)?.activeCustomers ?? 0;
    }

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      inWindow: {
        identifiedCustomers: w?.identified_customers ?? 0,
        walkInOrderCount: w?.walk_in_orders ?? 0,
        walkInRevenueCents: Number(w?.walk_in_revenue ?? 0),
        newCustomers: nr?.new_customers ?? 0,
        returningCustomers: nr?.returning_customers ?? 0,
        newRevenueCents: Number(nr?.new_revenue ?? 0),
        returningRevenueCents: Number(nr?.returning_revenue ?? 0),
      },
      cohorts: [...cohortMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cohortMonth, v]) => ({
          cohortMonth,
          cohortSize: v.size,
          cells: v.cells.sort((a, b) => a.monthOffset - b.monthOffset),
        })),
    };
  }
}
