import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Revenue − COGS roll-up from POS orders + product master.
 *
 * Approach: unnest pos_orders.order_lines into (productId, qty, unitPriceCents),
 * left-join to products to get name + category + avg_cost_cents, then aggregate.
 *
 * Caveats (surfaced honestly in the UI explainer):
 *   - COGS uses CURRENT avg_cost_cents, not the cost at time-of-sale. For a
 *     true retroactive margin you'd walk stock_moves with cost_layer_id; that
 *     is heavier than this dashboard call should be.
 *   - When a line's productId can't be matched, it's bucketed under
 *     "Unidentified" so revenue still totals correctly.
 *   - CN rows store negative qty/price already, so they self-net.
 */

export interface ProductMargin {
  productId: string | null;
  name: string;
  category: string | null;
  unitsSold: number;
  revenueCents: number;
  cogsCents: number;
  marginCents: number;
  marginPct: number; // 0..1, computed against revenue
}

export interface CategoryMargin {
  category: string;
  unitsSold: number;
  revenueCents: number;
  cogsCents: number;
  marginCents: number;
  marginPct: number;
}

export interface ProfitabilityReport {
  fromIso: string;
  toIso: string;
  totals: {
    unitsSold: number;
    revenueCents: number;
    cogsCents: number;
    marginCents: number;
    marginPct: number;
    skusSold: number;
    cogsCoveragePct: number; // share of revenue that we have a cost basis for
  };
  byProduct: ProductMargin[];     // top 25 by revenue
  byCategory: CategoryMargin[];   // all categories (incl. "Uncategorised")
}

@Injectable()
export class ProfitabilityService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<ProfitabilityReport> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Pull line-level rows in a single query. The CASE around the UUID cast
    // protects against test-seed productIds like "p-1" — invalid UUIDs would
    // raise 22P02 and crash the whole request.
    const lineRows = await this.db.execute<{
      product_id: string | null;
      name: string | null;
      category: string | null;
      unit_cost_cents: number | null;
      qty: number;
      revenue_cents: number;
    }>(sql`
      WITH lines AS (
        SELECT
          (line ->> 'productId')                        AS product_id_raw,
          (line ->> 'name')                             AS line_name,
          ((line ->> 'qty')::numeric)                   AS qty,
          ((line ->> 'qty')::numeric *
           (line ->> 'unitPriceCents')::bigint)::bigint AS revenue_cents
        FROM custom.pos_orders o,
             jsonb_array_elements(o.order_lines) AS line
        WHERE o.created_at >= ${from.toISOString()}::timestamptz
          AND o.created_at <  ${to.toISOString()}::timestamptz
      )
      SELECT
        CASE WHEN l.product_id_raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN l.product_id_raw::uuid
             ELSE NULL
        END                              AS product_id,
        COALESCE(p.name, l.line_name)    AS name,
        p.category                       AS category,
        p.avg_cost_cents                 AS unit_cost_cents,
        SUM(l.qty)::numeric              AS qty,
        SUM(l.revenue_cents)::bigint     AS revenue_cents
      FROM lines l
      LEFT JOIN custom.products p
        ON p.id = CASE WHEN l.product_id_raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN l.product_id_raw::uuid
                       ELSE NULL
                  END
      GROUP BY 1, 2, 3, 4
    `);

    // Drizzle returns either {rows: [...]} or [...] depending on driver version.
    const rows: any[] = (lineRows as any).rows ?? (lineRows as any) ?? [];

    let totalUnits = 0;
    let totalRevenue = 0;
    let totalCogs = 0;
    let revenueWithCost = 0;

    const byProduct: ProductMargin[] = [];
    const catMap = new Map<string, CategoryMargin>();

    for (const r of rows) {
      const qty = Number(r.qty ?? 0);
      const revenue = Number(r.revenue_cents ?? 0);
      const unitCost = r.unit_cost_cents != null ? Number(r.unit_cost_cents) : null;
      const cogs = unitCost != null ? Math.round(qty * unitCost) : 0;
      const hasCost = unitCost != null;

      totalUnits += qty;
      totalRevenue += revenue;
      totalCogs += cogs;
      if (hasCost) revenueWithCost += revenue;

      const productName: string =
        (r.name as string | null) ?? (r.product_id ? 'Unknown product' : 'Unidentified');
      const category = (r.category as string | null) ?? null;

      byProduct.push({
        productId: (r.product_id as string | null) ?? null,
        name: productName,
        category,
        unitsSold: qty,
        revenueCents: revenue,
        cogsCents: cogs,
        marginCents: revenue - cogs,
        marginPct: revenue > 0 ? (revenue - cogs) / revenue : 0,
      });

      const catKey = category ?? 'Uncategorised';
      const c = catMap.get(catKey) ?? {
        category: catKey,
        unitsSold: 0,
        revenueCents: 0,
        cogsCents: 0,
        marginCents: 0,
        marginPct: 0,
      };
      c.unitsSold += qty;
      c.revenueCents += revenue;
      c.cogsCents += cogs;
      c.marginCents = c.revenueCents - c.cogsCents;
      c.marginPct = c.revenueCents > 0 ? c.marginCents / c.revenueCents : 0;
      catMap.set(catKey, c);
    }

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      totals: {
        unitsSold: totalUnits,
        revenueCents: totalRevenue,
        cogsCents: totalCogs,
        marginCents: totalRevenue - totalCogs,
        marginPct: totalRevenue > 0 ? (totalRevenue - totalCogs) / totalRevenue : 0,
        skusSold: byProduct.length,
        cogsCoveragePct: totalRevenue > 0 ? revenueWithCost / totalRevenue : 0,
      },
      byProduct: byProduct.sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 25),
      byCategory: [...catMap.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    };
  }
}
