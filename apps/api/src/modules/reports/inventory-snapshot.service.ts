import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  products,
  stockQuants,
  stockMoves,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Tier-2 inventory roll-up for the Money Snapshot section.
 *
 *   value     — total cash tied up in stock = Σ qty_on_hand × avg_cost_cents
 *   coverage  — SKUs at-or-below reorder_point and SKUs at zero
 *   velocity  — stock_moves bucketed by move_type within [from, to)
 *
 * Pure read aggregation. No side effects. Auth + role enforcement happens at
 * the controller layer.
 */

export interface InventorySnapshot {
  asOfIso: string;
  value: {
    totalValueCents: number;
    skuCount: number;
    skusWithStock: number;
    skusZero: number;
    skusLow: number;
  };
  velocity: {
    fromIso: string;
    toIso: string;
    rows: Array<{
      moveType: string; // sale | receive | refund | adjust | transfer_in | transfer_out
      moveCount: number;
      qtyAbs: number;
    }>;
  };
}

@Injectable()
export class InventorySnapshotService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<InventorySnapshot> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── value + coverage (single SQL, no per-row JS)
    const [vRow] = await this.db
      .select({
        totalValueCents: sql<number>`
          COALESCE(SUM(${stockQuants.qtyOnHand} * ${products.avgCostCents}), 0)::bigint
        `,
        skuCount: sql<number>`COUNT(*)::int`,
        skusWithStock: sql<number>`COUNT(*) FILTER (WHERE ${stockQuants.qtyOnHand} > 0)::int`,
        skusZero: sql<number>`COUNT(*) FILTER (WHERE ${stockQuants.qtyOnHand} <= 0)::int`,
        skusLow: sql<number>`
          COUNT(*) FILTER (
            WHERE ${products.reorderPoint} IS NOT NULL
              AND ${stockQuants.qtyOnHand} <= ${products.reorderPoint}
          )::int
        `,
      })
      .from(stockQuants)
      .innerJoin(products, eq(products.id, stockQuants.productId))
      .where(eq(products.isActive, true));

    // ── velocity in window (count + |qty| per move_type)
    const velRows = await this.db
      .select({
        moveType: stockMoves.moveType,
        moveCount: sql<number>`COUNT(*)::int`,
        qtyAbs: sql<number>`COALESCE(SUM(ABS(${stockMoves.qty})), 0)::numeric`,
      })
      .from(stockMoves)
      .where(and(gte(stockMoves.performedAt, from), lt(stockMoves.performedAt, to)))
      .groupBy(stockMoves.moveType);

    return {
      asOfIso: now.toISOString(),
      value: {
        totalValueCents: Number(vRow?.totalValueCents ?? 0),
        skuCount: vRow?.skuCount ?? 0,
        skusWithStock: vRow?.skusWithStock ?? 0,
        skusZero: vRow?.skusZero ?? 0,
        skusLow: vRow?.skusLow ?? 0,
      },
      velocity: {
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
        rows: velRows.map((r) => ({
          moveType: r.moveType,
          moveCount: Number(r.moveCount),
          qtyAbs: Number(r.qtyAbs),
        })),
      },
    };
  }
}
