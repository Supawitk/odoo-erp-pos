import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, desc, asc, lte, gt } from 'drizzle-orm';
import { costLayers, products, warehouses, stockQuants, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

export interface ValuationLine {
  productId: string;
  productName: string;
  sku: string | null;
  warehouseId: string;
  warehouseCode: string;
  qtyOnHand: number;
  /** Sum across in_stock layers — the truthful FIFO/FEFO valuation. */
  layerValueCents: number;
  /** Cached moving-average × qty — sanity check against layer-sum. */
  avgCostValueCents: number | null;
  /** layerValueCents − avgCostValueCents, surfaced when non-zero so finance can investigate. */
  driftCents: number | null;
}

export interface CostLayerView {
  id: string;
  productId: string;
  productName: string;
  warehouseId: string;
  warehouseCode: string;
  lotCode: string | null;
  serialNo: string | null;
  expiryDate: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  unitCostCents: number;
  currency: string;
  status: string;
  receivedAt: Date;
  daysToExpiry: number | null;
}

/**
 * Read-only sibling to StockService for valuation queries. Mutations all flow
 * through StockService.receiveStock / consumeFEFO so the cost-layer state stays
 * consistent.
 */
@Injectable()
export class ValuationService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Per (product, warehouse) valuation. Defaults to all warehouses + active
   * products. Caller can pass productId / warehouseId to scope.
   */
  async getValuation(opts?: {
    productId?: string;
    warehouseId?: string;
  }): Promise<ValuationLine[]> {
    const conds = [eq(products.isActive, true)];
    if (opts?.productId) conds.push(eq(products.id, opts.productId));
    if (opts?.warehouseId) conds.push(eq(stockQuants.warehouseId, opts.warehouseId));

    const layerSum = sql<string>`(
      SELECT COALESCE(SUM(qty_remaining::numeric * unit_cost_cents), 0)
        FROM custom.cost_layers cl
       WHERE cl.product_id = ${products.id}
         AND cl.warehouse_id = ${stockQuants.warehouseId}
         AND cl.status = 'in_stock'
    )`;

    const rows = await this.db
      .select({
        productId: products.id,
        productName: products.name,
        sku: products.sku,
        warehouseId: stockQuants.warehouseId,
        warehouseCode: warehouses.code,
        qtyOnHand: stockQuants.qtyOnHand,
        avgCostCents: stockQuants.avgCostCents,
        layerValueCents: layerSum,
      })
      .from(products)
      .innerJoin(stockQuants, eq(stockQuants.productId, products.id))
      .innerJoin(warehouses, eq(warehouses.id, stockQuants.warehouseId))
      .where(and(...conds))
      .orderBy(products.name, warehouses.code);

    return rows.map((r) => {
      const qty = Number(r.qtyOnHand);
      const layer = Math.round(Number(r.layerValueCents ?? 0));
      const avgCost = r.avgCostCents != null ? Number(r.avgCostCents) : null;
      const avgVal = avgCost != null ? Math.round(avgCost * qty) : null;
      return {
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        warehouseId: r.warehouseId,
        warehouseCode: r.warehouseCode,
        qtyOnHand: qty,
        layerValueCents: layer,
        avgCostValueCents: avgVal,
        driftCents: avgVal != null ? layer - avgVal : null,
      };
    });
  }

  /** Cost layers for a product (newest receipt first) — diagnostic / drilldown. */
  async getCostLayers(productId: string, warehouseId?: string): Promise<CostLayerView[]> {
    const conds = [eq(costLayers.productId, productId)];
    if (warehouseId) conds.push(eq(costLayers.warehouseId, warehouseId));

    const rows = await this.db
      .select({
        id: costLayers.id,
        productId: costLayers.productId,
        productName: products.name,
        warehouseId: costLayers.warehouseId,
        warehouseCode: warehouses.code,
        lotCode: costLayers.lotCode,
        serialNo: costLayers.serialNo,
        expiryDate: costLayers.expiryDate,
        qtyReceived: costLayers.qtyReceived,
        qtyRemaining: costLayers.qtyRemaining,
        unitCostCents: costLayers.unitCostCents,
        currency: costLayers.currency,
        status: costLayers.status,
        receivedAt: costLayers.receivedAt,
      })
      .from(costLayers)
      .innerJoin(products, eq(products.id, costLayers.productId))
      .innerJoin(warehouses, eq(warehouses.id, costLayers.warehouseId))
      .where(and(...conds))
      .orderBy(desc(costLayers.receivedAt));

    const today = new Date();
    return rows.map((r) => {
      const exp = r.expiryDate ? new Date(r.expiryDate) : null;
      const days = exp
        ? Math.round((exp.getTime() - today.getTime()) / 86_400_000)
        : null;
      return {
        ...r,
        qtyReceived: Number(r.qtyReceived),
        qtyRemaining: Number(r.qtyRemaining),
        unitCostCents: Number(r.unitCostCents),
        daysToExpiry: days,
        receivedAt: r.receivedAt as Date,
      };
    });
  }

  /**
   * Layers expiring within `daysAhead` (default 30) with qty_remaining > 0.
   * Powers the daily expiry-soon BullMQ cron + the dashboard badge.
   */
  async getExpiringSoon(daysAhead = 30): Promise<CostLayerView[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysAhead);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        id: costLayers.id,
        productId: costLayers.productId,
        productName: products.name,
        warehouseId: costLayers.warehouseId,
        warehouseCode: warehouses.code,
        lotCode: costLayers.lotCode,
        serialNo: costLayers.serialNo,
        expiryDate: costLayers.expiryDate,
        qtyReceived: costLayers.qtyReceived,
        qtyRemaining: costLayers.qtyRemaining,
        unitCostCents: costLayers.unitCostCents,
        currency: costLayers.currency,
        status: costLayers.status,
        receivedAt: costLayers.receivedAt,
      })
      .from(costLayers)
      .innerJoin(products, eq(products.id, costLayers.productId))
      .innerJoin(warehouses, eq(warehouses.id, costLayers.warehouseId))
      .where(
        and(
          eq(costLayers.status, 'in_stock'),
          gt(costLayers.qtyRemaining, '0'),
          lte(costLayers.expiryDate, cutoffStr),
        ),
      )
      .orderBy(asc(costLayers.expiryDate));

    const today = new Date();
    return rows.map((r) => {
      const exp = r.expiryDate ? new Date(r.expiryDate) : null;
      const days = exp
        ? Math.round((exp.getTime() - today.getTime()) / 86_400_000)
        : null;
      return {
        ...r,
        qtyReceived: Number(r.qtyReceived),
        qtyRemaining: Number(r.qtyRemaining),
        unitCostCents: Number(r.unitCostCents),
        daysToExpiry: days,
        receivedAt: r.receivedAt as Date,
      };
    });
  }

  /** Aggregate value across the whole catalog, for the dashboard tile. */
  async getTotalValuationCents(warehouseId?: string): Promise<number> {
    const conds = [eq(costLayers.status, 'in_stock')];
    if (warehouseId) conds.push(eq(costLayers.warehouseId, warehouseId));
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${costLayers.qtyRemaining}::numeric * ${costLayers.unitCostCents}), 0)`,
      })
      .from(costLayers)
      .where(and(...conds));
    return Math.round(Number(row?.total ?? 0));
  }
}
