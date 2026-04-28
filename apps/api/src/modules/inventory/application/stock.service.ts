import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  costLayers,
  products,
  stockMoves,
  stockQuants,
  warehouses,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import {
  InsufficientStockError,
  WarehouseNotFoundError,
} from '../domain/errors';
import { LowStockAlertEvent, StockMovedEvent } from '../domain/events';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ApplyMoveInput {
  productId: string;
  qty: number; // signed: positive = receipt, negative = issue
  moveType:
    | 'receive'
    | 'sale'
    | 'transfer_in'
    | 'transfer_out'
    | 'adjust'
    | 'cycle_count_adjust'
    | 'damage'
    | 'expire'
    | 'refund';
  fromWarehouseId?: string;
  toWarehouseId?: string;
  unitCostCents?: number;
  sourceModule?: string;
  sourceId?: string;
  reference?: string;
  performedBy?: string;
  approvedBy?: string;
  reason?: string;
  branchCode?: string;
  costLayerId?: string;
}

export interface MoveResult {
  moveId: string;
  newQtyOnHand: number;
}

export interface ReceiveStockInput {
  productId: string;
  warehouseId?: string;
  qty: number; // must be > 0
  unitCostCents: number; // cost basis per unit (satang)
  currency?: string; // defaults to THB
  lotCode?: string;
  serialNo?: string;
  expiryDate?: Date | string; // ISO yyyy-mm-dd or Date
  removalDate?: Date | string;
  sourceModule?: string;
  sourceId?: string;
  reference?: string;
  performedBy?: string;
  branchCode?: string;
}

export interface ReceiveStockResult {
  moveId: string;
  layerId: string;
  newQtyOnHand: number;
  newAvgCostCents: number;
}

export interface ConsumeFefoInput {
  productId: string;
  warehouseId?: string;
  qty: number; // must be > 0; method handles the sign internally
  moveType?: 'sale' | 'damage' | 'expire' | 'transfer_out' | 'cycle_count_adjust' | 'adjust';
  sourceModule?: string;
  sourceId?: string;
  reference?: string;
  performedBy?: string;
  approvedBy?: string;
  reason?: string;
  branchCode?: string;
}

export interface ConsumeFefoResult {
  moveId: string;
  layerConsumption: { layerId: string; qty: number; unitCostCents: number }[];
  totalCostCents: number;
  newQtyOnHand: number;
}

/**
 * Single mutation path for stock. All callers (POS sale handler, GRN posting,
 * adjustments, transfers) go through this service. Responsibilities:
 *   - applyMove: simple ledger entry + cache update (no cost-layer accounting)
 *   - receiveStock: receipt with cost layer + moving-average recompute (Batch 2)
 *   - consumeFEFO: FEFO-ordered cost-layer drawdown using FOR UPDATE SKIP LOCKED
 *
 * Concurrency: read-committed isolation + row-lock on the quant + SKIP LOCKED on
 * cost layers. The Phase 3 Batch 1 gate test verifies that 10 parallel sales of
 * the last unit produce exactly 1 success + 9 InsufficientStockError.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly eventBus: EventBus,
  ) {}

  // ─── Warehouse resolution ───────────────────────────────────────────
  private mainWarehouseIdCache: string | null = null;
  async resolveMainWarehouse(): Promise<string> {
    if (this.mainWarehouseIdCache) return this.mainWarehouseIdCache;
    const rows = await this.db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.code, 'MAIN'), eq(warehouses.isActive, true)))
      .limit(1);
    if (!rows[0]) throw new WarehouseNotFoundError('MAIN');
    this.mainWarehouseIdCache = rows[0].id;
    return this.mainWarehouseIdCache;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * UPSERT-and-lock: ensures a stock_quants row exists for (product, warehouse)
   * then re-reads it with FOR UPDATE so the rest of the tx body has serialised
   * access. Returns current qty + reserved + cached avg cost.
   */
  private async _acquireQuantLock(
    tx: Tx,
    productId: string,
    warehouseId: string,
  ): Promise<{ qtyOnHand: number; qtyReserved: number; avgCostCents: number }> {
    await tx
      .insert(stockQuants)
      .values({ productId, warehouseId, qtyOnHand: '0', qtyReserved: '0' })
      .onConflictDoNothing();
    const lockedRows = await tx.execute(
      sql`SELECT qty_on_hand::numeric AS qty_on_hand,
                 qty_reserved::numeric AS qty_reserved,
                 avg_cost_cents
            FROM custom.stock_quants
            WHERE product_id = ${productId} AND warehouse_id = ${warehouseId}
            FOR UPDATE`,
    );
    const locked =
      (lockedRows as unknown as { rows?: any[] }).rows?.[0] ??
      (lockedRows as any)[0] ??
      null;
    return {
      qtyOnHand: Number(locked?.qty_on_hand ?? 0),
      qtyReserved: Number(locked?.qty_reserved ?? 0),
      avgCostCents: Number(locked?.avg_cost_cents ?? 0),
    };
  }

  private async _writeQuant(
    tx: Tx,
    productId: string,
    warehouseId: string,
    newQty: number,
    newAvgCostCents?: number | null,
  ): Promise<void> {
    const setPayload: Record<string, unknown> = {
      qtyOnHand: String(newQty),
      updatedAt: new Date(),
    };
    if (newAvgCostCents !== undefined) {
      setPayload.avgCostCents = newAvgCostCents;
    }
    await tx
      .update(stockQuants)
      .set(setPayload)
      .where(
        and(eq(stockQuants.productId, productId), eq(stockQuants.warehouseId, warehouseId)),
      );

    // Sync legacy products.stock_qty (and avg cost) for the MAIN warehouse so
    // the existing /api/products endpoint keeps working until the web is
    // migrated to read from stock_quants directly.
    const main = await this.resolveMainWarehouse();
    if (warehouseId === main) {
      const productSet: Record<string, unknown> = {
        stockQty: String(newQty),
        updatedAt: new Date(),
      };
      if (newAvgCostCents !== undefined && newAvgCostCents !== null) {
        productSet.avgCostCents = newAvgCostCents;
      }
      await tx.update(products).set(productSet).where(eq(products.id, productId));
    }
  }

  // ─── applyMove (Batch 1 — simple ledger, no cost-layer accounting) ─
  /**
   * Apply a stock move atomically. Idempotent via the (source_module, source_id,
   * product_id) UNIQUE on stock_moves — replays return the existing move id
   * rather than re-applying the qty change.
   *
   * For valuation-aware paths (POS sale with COGS, GRN receipt) prefer
   * receiveStock / consumeFEFO. applyMove is retained for adjustments,
   * transfers, and refunds where layer accounting is not yet wired.
   */
  async applyMove(input: ApplyMoveInput): Promise<MoveResult> {
    if (input.qty === 0) throw new Error('qty must be non-zero');

    if (input.sourceModule && input.sourceId) {
      const existing = await this.db
        .select({ id: stockMoves.id })
        .from(stockMoves)
        .where(
          and(
            eq(stockMoves.sourceModule, input.sourceModule),
            eq(stockMoves.sourceId, input.sourceId),
            eq(stockMoves.productId, input.productId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        this.logger.warn(
          `Idempotent replay: stock_move source=${input.sourceModule}:${input.sourceId} product=${input.productId}`,
        );
        const targetWh =
          (input.qty < 0 ? input.fromWarehouseId : input.toWarehouseId) ??
          (await this.resolveMainWarehouse());
        const onHand = await this.getQuantOnHand(input.productId, targetWh);
        return { moveId: existing[0].id, newQtyOnHand: onHand };
      }
    }

    const targetWarehouseId =
      input.qty > 0
        ? input.toWarehouseId ?? (await this.resolveMainWarehouse())
        : input.fromWarehouseId ?? (await this.resolveMainWarehouse());

    const result = await this.db.transaction(async (tx) => {
      const { qtyOnHand: currentQty, qtyReserved: reserved } = await this._acquireQuantLock(
        tx,
        input.productId,
        targetWarehouseId,
      );

      const nextQty = currentQty + input.qty;
      if (nextQty < 0 && !input.approvedBy) {
        throw new InsufficientStockError(
          input.productId,
          targetWarehouseId,
          Math.abs(input.qty),
          Math.max(0, currentQty - reserved),
        );
      }

      const moveId = uuidv7();
      try {
        await tx.insert(stockMoves).values({
          id: moveId,
          productId: input.productId,
          moveType: input.moveType,
          qty: String(input.qty),
          fromWarehouseId: input.fromWarehouseId ?? null,
          toWarehouseId: input.toWarehouseId ?? null,
          costLayerId: input.costLayerId ?? null,
          unitCostCents: input.unitCostCents ?? null,
          sourceModule: input.sourceModule ?? null,
          sourceId: input.sourceId ?? null,
          reference: input.reference ?? null,
          performedBy: input.performedBy ?? null,
          approvedBy: input.approvedBy ?? null,
          reason: input.reason ?? null,
          branchCode: input.branchCode ?? null,
        });
      } catch (err: any) {
        if (err?.code === '23505' && input.sourceModule && input.sourceId) {
          this.logger.warn(
            `Race-replay: ${input.sourceModule}:${input.sourceId} for product ${input.productId}`,
          );
          const raced = await tx
            .select({ id: stockMoves.id })
            .from(stockMoves)
            .where(
              and(
                eq(stockMoves.sourceModule, input.sourceModule),
                eq(stockMoves.sourceId, input.sourceId),
                eq(stockMoves.productId, input.productId),
              ),
            )
            .limit(1);
          if (raced[0]) {
            return { moveId: raced[0].id, newQtyOnHand: currentQty };
          }
        }
        throw err;
      }

      await this._writeQuant(tx, input.productId, targetWarehouseId, nextQty);

      const [productRow] = await tx
        .select({
          name: products.name,
          reorderPoint: products.reorderPoint,
          reorderQty: products.reorderQty,
        })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      return {
        moveId,
        newQtyOnHand: nextQty,
        _eventCtx: {
          productName: productRow?.name ?? '(unknown)',
          reorderPoint:
            productRow?.reorderPoint != null ? Number(productRow.reorderPoint) : null,
          reorderQty: productRow?.reorderQty != null ? Number(productRow.reorderQty) : null,
          targetWarehouseId,
        },
      } as MoveResult & { _eventCtx: any };
    });

    const { _eventCtx, ...clean } = result as any;
    this.eventBus.publish(
      new StockMovedEvent(
        clean.moveId,
        input.productId,
        input.moveType,
        input.qty,
        input.fromWarehouseId ?? null,
        input.toWarehouseId ?? null,
        input.unitCostCents ?? null,
        input.sourceModule ?? null,
        input.sourceId ?? null,
        new Date(),
      ),
    );

    if (
      _eventCtx.reorderPoint != null &&
      clean.newQtyOnHand <= _eventCtx.reorderPoint
    ) {
      this.eventBus.publish(
        new LowStockAlertEvent(
          input.productId,
          _eventCtx.productName,
          _eventCtx.targetWarehouseId,
          clean.newQtyOnHand,
          _eventCtx.reorderPoint,
          _eventCtx.reorderQty,
          new Date(),
        ),
      );
    }

    this.logger.log(
      `Move ${clean.moveId} type=${input.moveType} qty=${input.qty} product=${input.productId} new=${clean.newQtyOnHand}`,
    );
    return clean;
  }

  // ─── receiveStock (Batch 2 — receipt + cost layer + avg cost) ──────
  /**
   * Receive inventory: creates a cost_layer row, writes the receive stock_move
   * linked to it, and recomputes the moving-average cost on the quant.
   *
   *   newAvg = round((currentAvg * currentQty + unitCost * qty) / (currentQty + qty))
   *
   * Idempotent via (sourceModule, sourceId, productId) on stock_moves. A replay
   * returns the existing move/layer ids without re-creating a layer.
   */
  async receiveStock(input: ReceiveStockInput): Promise<ReceiveStockResult> {
    if (input.qty <= 0) throw new Error('receiveStock: qty must be > 0');
    if (input.unitCostCents < 0) throw new Error('receiveStock: unitCostCents must be >= 0');

    const targetWarehouseId =
      input.warehouseId ?? (await this.resolveMainWarehouse());

    if (input.sourceModule && input.sourceId) {
      const existing = await this.db
        .select({ moveId: stockMoves.id, layerId: stockMoves.costLayerId })
        .from(stockMoves)
        .where(
          and(
            eq(stockMoves.sourceModule, input.sourceModule),
            eq(stockMoves.sourceId, input.sourceId),
            eq(stockMoves.productId, input.productId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        this.logger.warn(
          `Idempotent replay: receiveStock source=${input.sourceModule}:${input.sourceId} product=${input.productId}`,
        );
        const onHand = await this.getQuantOnHand(input.productId, targetWarehouseId);
        const [q] = await this.db
          .select({ avgCostCents: stockQuants.avgCostCents })
          .from(stockQuants)
          .where(
            and(
              eq(stockQuants.productId, input.productId),
              eq(stockQuants.warehouseId, targetWarehouseId),
            ),
          )
          .limit(1);
        return {
          moveId: existing[0].moveId,
          layerId: existing[0].layerId ?? '',
          newQtyOnHand: onHand,
          newAvgCostCents: Number(q?.avgCostCents ?? 0),
        };
      }
    }

    const result = await this.db.transaction(async (tx) => {
      const { qtyOnHand: currentQty, avgCostCents: currentAvg } =
        await this._acquireQuantLock(tx, input.productId, targetWarehouseId);

      const layerId = uuidv7();
      const moveId = uuidv7();

      const expiry = toIsoDate(input.expiryDate);
      const removal = toIsoDate(input.removalDate);

      await tx.insert(costLayers).values({
        id: layerId,
        productId: input.productId,
        warehouseId: targetWarehouseId,
        lotCode: input.lotCode ?? null,
        serialNo: input.serialNo ?? null,
        expiryDate: expiry,
        removalDate: removal,
        qtyReceived: String(input.qty),
        qtyRemaining: String(input.qty),
        unitCostCents: input.unitCostCents,
        currency: input.currency ?? 'THB',
        status: 'in_stock',
        sourceMoveId: moveId,
      });

      try {
        await tx.insert(stockMoves).values({
          id: moveId,
          productId: input.productId,
          moveType: 'receive',
          qty: String(input.qty),
          toWarehouseId: targetWarehouseId,
          costLayerId: layerId,
          unitCostCents: input.unitCostCents,
          sourceModule: input.sourceModule ?? null,
          sourceId: input.sourceId ?? null,
          reference: input.reference ?? null,
          performedBy: input.performedBy ?? null,
          branchCode: input.branchCode ?? null,
        });
      } catch (err: any) {
        if (err?.code === '23505' && input.sourceModule && input.sourceId) {
          this.logger.warn(
            `Race-replay: receiveStock ${input.sourceModule}:${input.sourceId}`,
          );
          // tx will roll back, including the costLayer insert above
        }
        throw err;
      }

      // Moving-average recompute. Done in satang.
      const totalValue = currentAvg * currentQty + input.unitCostCents * input.qty;
      const newQty = currentQty + input.qty;
      const newAvgCost = newQty > 0 ? Math.round(totalValue / newQty) : input.unitCostCents;

      await this._writeQuant(tx, input.productId, targetWarehouseId, newQty, newAvgCost);

      return { moveId, layerId, newQtyOnHand: newQty, newAvgCostCents: newAvgCost };
    });

    this.eventBus.publish(
      new StockMovedEvent(
        result.moveId,
        input.productId,
        'receive',
        input.qty,
        null,
        targetWarehouseId,
        input.unitCostCents,
        input.sourceModule ?? null,
        input.sourceId ?? null,
        new Date(),
      ),
    );

    this.logger.log(
      `Receive ${result.moveId} layer=${result.layerId} qty=${input.qty} unitCost=${input.unitCostCents} avg=${result.newAvgCostCents}`,
    );
    return result;
  }

  // ─── consumeFEFO (Batch 2 — FEFO drawdown with SKIP LOCKED) ─────────
  /**
   * Consume inventory in FEFO order (closest expiry first, then oldest receipt).
   * Layers are locked with FOR UPDATE SKIP LOCKED so concurrent consumers don't
   * block each other — they each pull the next available layer.
   *
   * Writes ONE stock_move per call; per-layer breakdown is stored in
   * layer_consumption JSON (so Phase 4 COGS journals can drill into it without
   * an extra table).
   *
   * Negative-stock guard: if the available qty across all in_stock layers is
   * less than requested, throws InsufficientStockError UNLESS approvedBy is
   * provided (manager override creates a layer-less shortfall move).
   */
  async consumeFEFO(input: ConsumeFefoInput): Promise<ConsumeFefoResult> {
    if (input.qty <= 0) throw new Error('consumeFEFO: qty must be > 0');

    const moveType = input.moveType ?? 'sale';
    const targetWarehouseId =
      input.warehouseId ?? (await this.resolveMainWarehouse());

    if (input.sourceModule && input.sourceId) {
      const [existing] = await this.db
        .select({
          id: stockMoves.id,
          qty: stockMoves.qty,
          unitCostCents: stockMoves.unitCostCents,
          layerConsumption: stockMoves.layerConsumption,
        })
        .from(stockMoves)
        .where(
          and(
            eq(stockMoves.sourceModule, input.sourceModule),
            eq(stockMoves.sourceId, input.sourceId),
            eq(stockMoves.productId, input.productId),
          ),
        )
        .limit(1);
      if (existing) {
        this.logger.warn(
          `Idempotent replay: consumeFEFO source=${input.sourceModule}:${input.sourceId} product=${input.productId}`,
        );
        const onHand = await this.getQuantOnHand(input.productId, targetWarehouseId);
        const lc =
          (existing.layerConsumption as
            | { layerId: string; qty: number; unitCostCents: number }[]
            | null) ?? [];
        const totalCost = lc.reduce(
          (sum, x) => sum + x.qty * x.unitCostCents,
          0,
        );
        return {
          moveId: existing.id,
          layerConsumption: lc,
          totalCostCents: totalCost,
          newQtyOnHand: onHand,
        };
      }
    }

    const result = await this.db.transaction(async (tx) => {
      const { qtyOnHand: currentQty } = await this._acquireQuantLock(
        tx,
        input.productId,
        targetWarehouseId,
      );

      // FEFO layer query with SKIP LOCKED so parallel consumers each pick the
      // next-available layer instead of blocking on a single locked row.
      const layerRows = await tx.execute(
        sql`SELECT id, qty_remaining::numeric AS qty_remaining, unit_cost_cents,
                   expiry_date, received_at
              FROM custom.cost_layers
              WHERE product_id = ${input.productId}
                AND warehouse_id = ${targetWarehouseId}
                AND status = 'in_stock'
                AND qty_remaining::numeric > 0
              ORDER BY COALESCE(expiry_date, '9999-12-31'::date), received_at
              FOR UPDATE SKIP LOCKED`,
      );
      const layers = ((layerRows as any).rows ?? (layerRows as any)) as Array<{
        id: string;
        qty_remaining: string;
        unit_cost_cents: number;
        expiry_date: string | null;
        received_at: Date;
      }>;

      let remaining = input.qty;
      const consumption: { layerId: string; qty: number; unitCostCents: number }[] = [];

      for (const layer of layers) {
        if (remaining <= 0) break;
        const layerQty = Number(layer.qty_remaining);
        const consume = Math.min(remaining, layerQty);
        const newRemaining = layerQty - consume;
        const newStatus = newRemaining === 0 ? 'consumed' : 'in_stock';
        await tx
          .update(costLayers)
          .set({
            qtyRemaining: String(newRemaining),
            status: newStatus,
            updatedAt: new Date(),
          })
          .where(eq(costLayers.id, layer.id));
        consumption.push({
          layerId: layer.id,
          qty: consume,
          unitCostCents: Number(layer.unit_cost_cents),
        });
        remaining -= consume;
      }

      // If layers couldn't satisfy:
      //   - approvedBy set → log shortfall as a layerless slice (manager override)
      //   - else → throw InsufficientStockError
      if (remaining > 0) {
        if (!input.approvedBy) {
          throw new InsufficientStockError(
            input.productId,
            targetWarehouseId,
            input.qty,
            input.qty - remaining,
          );
        }
        consumption.push({ layerId: '', qty: remaining, unitCostCents: 0 });
        remaining = 0;
      }

      const totalCostCents = consumption.reduce(
        (sum, c) => sum + c.qty * c.unitCostCents,
        0,
      );

      // Single aggregate stock_move with full layer breakdown in JSON.
      // costLayerId is set when one-and-only-one real layer was used (the
      // common case for cheap retail); otherwise null and JSON is the source.
      const realLayers = consumption.filter((c) => c.layerId);
      const moveId = uuidv7();
      const aggregateUnitCost =
        consumption.length > 0 && input.qty > 0
          ? Math.round(totalCostCents / input.qty)
          : null;

      try {
        await tx.insert(stockMoves).values({
          id: moveId,
          productId: input.productId,
          moveType,
          qty: String(-input.qty),
          fromWarehouseId: targetWarehouseId,
          costLayerId: realLayers.length === 1 ? realLayers[0].layerId : null,
          unitCostCents: aggregateUnitCost,
          sourceModule: input.sourceModule ?? null,
          sourceId: input.sourceId ?? null,
          reference: input.reference ?? null,
          performedBy: input.performedBy ?? null,
          approvedBy: input.approvedBy ?? null,
          reason: input.reason ?? null,
          branchCode: input.branchCode ?? null,
          layerConsumption: consumption,
        });
      } catch (err: any) {
        if (err?.code === '23505' && input.sourceModule && input.sourceId) {
          this.logger.warn(
            `Race-replay: consumeFEFO ${input.sourceModule}:${input.sourceId}`,
          );
          const [raced] = await tx
            .select({
              id: stockMoves.id,
              layerConsumption: stockMoves.layerConsumption,
            })
            .from(stockMoves)
            .where(
              and(
                eq(stockMoves.sourceModule, input.sourceModule),
                eq(stockMoves.sourceId, input.sourceId),
                eq(stockMoves.productId, input.productId),
              ),
            )
            .limit(1);
          if (raced) {
            return {
              moveId: raced.id,
              layerConsumption:
                (raced.layerConsumption as typeof consumption | null) ?? [],
              totalCostCents,
              newQtyOnHand: currentQty,
            };
          }
        }
        throw err;
      }

      const newQty = currentQty - input.qty;
      await this._writeQuant(tx, input.productId, targetWarehouseId, newQty);

      // Re-read product reorder rule for low-stock alert in after-commit hook.
      const [productRow] = await tx
        .select({
          name: products.name,
          reorderPoint: products.reorderPoint,
          reorderQty: products.reorderQty,
        })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      return {
        moveId,
        layerConsumption: consumption,
        totalCostCents,
        newQtyOnHand: newQty,
        _eventCtx: {
          productName: productRow?.name ?? '(unknown)',
          reorderPoint:
            productRow?.reorderPoint != null ? Number(productRow.reorderPoint) : null,
          reorderQty: productRow?.reorderQty != null ? Number(productRow.reorderQty) : null,
          targetWarehouseId,
        },
      } as ConsumeFefoResult & { _eventCtx: any };
    });

    const { _eventCtx, ...clean } = result as any;

    this.eventBus.publish(
      new StockMovedEvent(
        clean.moveId,
        input.productId,
        moveType,
        -input.qty,
        targetWarehouseId,
        null,
        clean.layerConsumption.length > 0 && input.qty > 0
          ? Math.round(clean.totalCostCents / input.qty)
          : null,
        input.sourceModule ?? null,
        input.sourceId ?? null,
        new Date(),
      ),
    );

    if (
      _eventCtx?.reorderPoint != null &&
      clean.newQtyOnHand <= _eventCtx.reorderPoint
    ) {
      this.eventBus.publish(
        new LowStockAlertEvent(
          input.productId,
          _eventCtx.productName,
          _eventCtx.targetWarehouseId,
          clean.newQtyOnHand,
          _eventCtx.reorderPoint,
          _eventCtx.reorderQty,
          new Date(),
        ),
      );
    }

    this.logger.log(
      `ConsumeFEFO ${clean.moveId} ${moveType} qty=${input.qty} layers=${clean.layerConsumption.length} cost=${clean.totalCostCents} new=${clean.newQtyOnHand}`,
    );
    return clean;
  }

  // ─── Transfer (warehouse → warehouse) ──────────────────────────────────
  /**
   * Move stock from one warehouse to another in a single transaction.
   *
   * Writes two `stock_moves` rows (transfer_out + transfer_in) atomically and
   * decrements/increments the corresponding `stock_quants` rows. Idempotent
   * via the shared `transferId` used as `source_id` on both legs.
   *
   * Lock-order rule: warehouses are locked in id-string order to avoid
   * deadlocks when concurrent transfers go in opposite directions
   * (A→B and B→A).
   */
  async transferStock(input: {
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    qty: number;
    reason?: string;
    performedBy?: string;
    branchCode?: string;
    /** Optional caller-supplied id for idempotency. Auto-generated if absent. */
    transferId?: string;
  }): Promise<{
    transferId: string;
    outMoveId: string;
    inMoveId: string;
    fromQtyAfter: number;
    toQtyAfter: number;
  }> {
    if (input.qty <= 0) throw new Error('transferStock: qty must be > 0');
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new Error('transferStock: from and to warehouses must differ');
    }

    const transferId = input.transferId ?? uuidv7();

    // Idempotent replay — out and in legs use suffixed source_ids so they
    // don't collide on the (source_module, source_id, product_id) UNIQUE.
    const outSourceId = `${transferId}:out`;
    const inSourceId = `${transferId}:in`;
    const existing = await this.db
      .select({ id: stockMoves.id, type: stockMoves.moveType, sourceId: stockMoves.sourceId })
      .from(stockMoves)
      .where(
        and(
          eq(stockMoves.sourceModule, 'inventory.transfer'),
          eq(stockMoves.productId, input.productId),
        ),
      );
    const matched = existing.filter(
      (r) => r.sourceId === outSourceId || r.sourceId === inSourceId,
    );
    if (matched.length === 2) {
      const out = matched.find((r) => r.type === 'transfer_out')!;
      const into = matched.find((r) => r.type === 'transfer_in')!;
      const fromQ = await this.getQuantOnHand(input.productId, input.fromWarehouseId);
      const toQ = await this.getQuantOnHand(input.productId, input.toWarehouseId);
      this.logger.warn(`Idempotent replay: transfer ${transferId}`);
      return {
        transferId,
        outMoveId: out.id,
        inMoveId: into.id,
        fromQtyAfter: fromQ,
        toQtyAfter: toQ,
      };
    }

    return await this.db.transaction(async (tx) => {
      // Lock in stable order to avoid cross-direction deadlocks
      const [firstWh, secondWh] =
        input.fromWarehouseId < input.toWarehouseId
          ? [input.fromWarehouseId, input.toWarehouseId]
          : [input.toWarehouseId, input.fromWarehouseId];

      const firstLock = await this._acquireQuantLock(tx, input.productId, firstWh);
      const secondLock = await this._acquireQuantLock(tx, input.productId, secondWh);
      const fromLock =
        firstWh === input.fromWarehouseId ? firstLock : secondLock;

      if (fromLock.qtyOnHand < input.qty) {
        throw new InsufficientStockError(
          input.productId,
          input.fromWarehouseId,
          input.qty,
          Math.max(0, fromLock.qtyOnHand - fromLock.qtyReserved),
        );
      }

      const outMoveId = uuidv7();
      const inMoveId = uuidv7();
      const performedAt = new Date();

      // Decrement source warehouse
      await tx.insert(stockMoves).values({
        id: outMoveId,
        productId: input.productId,
        moveType: 'transfer_out',
        qty: String(-input.qty),
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        sourceModule: 'inventory.transfer',
        sourceId: outSourceId,
        reference: input.reason ?? null,
        performedBy: input.performedBy ?? null,
        reason: input.reason ?? null,
        branchCode: input.branchCode ?? null,
        performedAt,
      });

      // Increment dest warehouse
      await tx.insert(stockMoves).values({
        id: inMoveId,
        productId: input.productId,
        moveType: 'transfer_in',
        qty: String(input.qty),
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        sourceModule: 'inventory.transfer',
        sourceId: inSourceId,
        reference: input.reason ?? null,
        performedBy: input.performedBy ?? null,
        reason: input.reason ?? null,
        branchCode: input.branchCode ?? null,
        performedAt,
      });

      const newFrom = fromLock.qtyOnHand - input.qty;
      const newTo =
        (firstWh === input.toWarehouseId ? firstLock : secondLock).qtyOnHand + input.qty;

      await this._writeQuant(tx, input.productId, input.fromWarehouseId, newFrom);
      await this._writeQuant(tx, input.productId, input.toWarehouseId, newTo);

      // Emit two domain events so listeners (Odoo outbox, low-stock alerts)
      // see both legs of the transfer.
      this.eventBus.publish(
        new StockMovedEvent(
          outMoveId,
          input.productId,
          'transfer_out',
          -input.qty,
          input.fromWarehouseId,
          input.toWarehouseId,
          null,
          'inventory.transfer',
          outSourceId,
          performedAt,
        ),
      );
      this.eventBus.publish(
        new StockMovedEvent(
          inMoveId,
          input.productId,
          'transfer_in',
          input.qty,
          input.fromWarehouseId,
          input.toWarehouseId,
          null,
          'inventory.transfer',
          inSourceId,
          performedAt,
        ),
      );

      this.logger.log(
        `Transfer ${transferId} product=${input.productId} qty=${input.qty} ${input.fromWarehouseId}→${input.toWarehouseId}`,
      );

      return {
        transferId,
        outMoveId,
        inMoveId,
        fromQtyAfter: newFrom,
        toQtyAfter: newTo,
      };
    });
  }

  // ─── Read helpers ────────────────────────────────────────────────────
  async getQuantOnHand(productId: string, warehouseId: string): Promise<number> {
    const rows = await this.db
      .select({ qtyOnHand: stockQuants.qtyOnHand })
      .from(stockQuants)
      .where(
        and(eq(stockQuants.productId, productId), eq(stockQuants.warehouseId, warehouseId)),
      )
      .limit(1);
    return rows[0] ? Number(rows[0].qtyOnHand) : 0;
  }
}

/** Convert a Date or ISO string into a Postgres `date` literal (yyyy-mm-dd). */
function toIsoDate(d: Date | string | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}
