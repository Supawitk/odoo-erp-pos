import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import {
  products,
  stockMoves,
  stockQuants,
  warehouses,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { StockService } from '../application/stock.service';
import { ValuationService } from '../application/valuation.service';
import { CycleCountService } from '../application/cycle-count.service';
import { OutboxService } from '../infrastructure/outbox.service';
import { OutboxRelayService } from '../infrastructure/outbox-relay.service';
import { ReconciliationCronService } from '../infrastructure/reconciliation-cron.service';

interface ProductStockRow {
  productId: string;
  productName: string;
  sku: string | null;
  warehouseId: string;
  warehouseCode: string;
  qtyOnHand: number;
  qtyReserved: number;
  reorderPoint: number | null;
  isLow: boolean;
  unitOfMeasure: string;
}

interface RecentMoveRow {
  id: string;
  productId: string;
  productName: string;
  moveType: string;
  qty: number;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  unitCostCents: number | null;
  reference: string | null;
  performedAt: Date;
}

interface ReceiveStockBody {
  productId: string;
  warehouseId?: string;
  qty: number;
  unitCostCents: number;
  currency?: string;
  lotCode?: string;
  serialNo?: string;
  expiryDate?: string;
  removalDate?: string;
  sourceModule?: string;
  sourceId?: string;
  reference?: string;
  performedBy?: string;
  branchCode?: string;
}

interface AdjustStockBody {
  productId: string;
  warehouseId?: string;
  qty: number; // signed: + add, − remove
  reason: string;
  approvedBy?: string;
  performedBy?: string;
  branchCode?: string;
}

interface OpenCycleCountBody {
  warehouseId?: string;
  counterUserId: string;
  notes?: string;
}

interface SubmitCycleCountBody {
  lines: { productId: string; countedQty: number }[];
}

interface PostCycleCountBody {
  approvedBy?: string;
}

@Controller('api/inventory')
export class InventoryController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly stock: StockService,
    private readonly valuation: ValuationService,
    private readonly cycleCount: CycleCountService,
    private readonly outbox: OutboxService,
    private readonly outboxRelay: OutboxRelayService,
    private readonly reconciliation: ReconciliationCronService,
  ) {}

  // ─── Warehouses + stock view ────────────────────────────────────────
  @Get('warehouses')
  async listWarehouses() {
    return this.db
      .select({
        id: warehouses.id,
        code: warehouses.code,
        name: warehouses.name,
        branchCode: warehouses.branchCode,
        timezone: warehouses.timezone,
        isActive: warehouses.isActive,
      })
      .from(warehouses)
      .where(eq(warehouses.isActive, true))
      .orderBy(warehouses.code);
  }

  @Get('stock')
  async stockView(
    @Query('warehouseId') warehouseId?: string,
    @Query('lowOnly') lowOnly?: string,
  ): Promise<ProductStockRow[]> {
    const wh = await this.resolveWarehouse(warehouseId);
    const rows = await this.db
      .select({
        productId: products.id,
        productName: products.name,
        sku: products.sku,
        unitOfMeasure: products.unitOfMeasure,
        reorderPoint: products.reorderPoint,
        warehouseId: warehouses.id,
        warehouseCode: warehouses.code,
        qtyOnHand: stockQuants.qtyOnHand,
        qtyReserved: stockQuants.qtyReserved,
      })
      .from(products)
      .leftJoin(
        stockQuants,
        and(eq(stockQuants.productId, products.id), eq(stockQuants.warehouseId, wh.id)),
      )
      .leftJoin(warehouses, eq(warehouses.id, wh.id))
      .where(eq(products.isActive, true))
      .orderBy(products.name);

    const mapped: ProductStockRow[] = rows.map((r) => {
      const onHand = r.qtyOnHand != null ? Number(r.qtyOnHand) : 0;
      const reserved = r.qtyReserved != null ? Number(r.qtyReserved) : 0;
      const reorder = r.reorderPoint != null ? Number(r.reorderPoint) : null;
      const isLow = reorder != null && onHand <= reorder;
      return {
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        unitOfMeasure: r.unitOfMeasure,
        warehouseId: wh.id,
        warehouseCode: wh.code,
        qtyOnHand: onHand,
        qtyReserved: reserved,
        reorderPoint: reorder,
        isLow,
      };
    });

    return lowOnly === 'true' ? mapped.filter((r) => r.isLow) : mapped;
  }

  @Get('moves')
  async recentMoves(
    @Query('productId') productId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<RecentMoveRow[]> {
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 500);
    const conditions = [];
    if (productId) conditions.push(eq(stockMoves.productId, productId));
    if (from) conditions.push(gte(stockMoves.performedAt, new Date(from)));
    if (to) conditions.push(lte(stockMoves.performedAt, new Date(to)));

    const rows = await this.db
      .select({
        id: stockMoves.id,
        productId: stockMoves.productId,
        productName: products.name,
        moveType: stockMoves.moveType,
        qty: stockMoves.qty,
        fromWarehouseId: stockMoves.fromWarehouseId,
        toWarehouseId: stockMoves.toWarehouseId,
        unitCostCents: stockMoves.unitCostCents,
        reference: stockMoves.reference,
        performedAt: stockMoves.performedAt,
      })
      .from(stockMoves)
      .leftJoin(products, eq(products.id, stockMoves.productId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(stockMoves.performedAt))
      .limit(limit);

    const whIds = Array.from(
      new Set(
        rows.flatMap((r) => [r.fromWarehouseId, r.toWarehouseId].filter(Boolean) as string[]),
      ),
    );
    const whMap = new Map<string, string>();
    if (whIds.length > 0) {
      const whRows = await this.db
        .select({ id: warehouses.id, code: warehouses.code })
        .from(warehouses)
        .where(inArray(warehouses.id, whIds));
      whRows.forEach((w) => whMap.set(w.id, w.code));
    }

    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.productName ?? '(unknown)',
      moveType: r.moveType,
      qty: Number(r.qty),
      fromWarehouse: r.fromWarehouseId ? whMap.get(r.fromWarehouseId) ?? null : null,
      toWarehouse: r.toWarehouseId ? whMap.get(r.toWarehouseId) ?? null : null,
      unitCostCents: r.unitCostCents != null ? Number(r.unitCostCents) : null,
      reference: r.reference,
      performedAt: r.performedAt as Date,
    }));
  }

  @Get('low-stock')
  async lowStock(@Query('warehouseId') warehouseId?: string) {
    return this.stockView(warehouseId, 'true');
  }

  /**
   * CSV stock-on-hand export. Phase 3 gate item — finance + ops can pull
   * the current snapshot for spreadsheet pivots / external warehouse audits.
   * UTF-8 BOM so Excel renders Thai correctly.
   */
  @Get('stock.csv')
  async stockCsv(
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('lowOnly') lowOnly: string | undefined,
    @Res({ passthrough: false }) reply: any,
  ) {
    const rows = await this.stockView(warehouseId, lowOnly);
    const header = ['warehouse_code', 'sku', 'product_name', 'qty_on_hand', 'qty_reserved', 'reorder_point', 'is_low'].join(',');
    const lines = rows.map((r) =>
      [
        r.warehouseCode,
        r.sku ?? '',
        '"' + (r.productName ?? '').replace(/"/g, '""') + '"',
        r.qtyOnHand.toFixed(3),
        r.qtyReserved.toFixed(3),
        r.reorderPoint != null ? r.reorderPoint.toFixed(3) : '',
        r.isLow ? '1' : '0',
      ].join(','),
    );
    const csv = '﻿' + header + '\n' + lines.join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename=stock-on-hand-${stamp}.csv`)
      .send(csv);
  }

  // ─── Valuation + cost layers ────────────────────────────────────────
  @Get('valuation')
  async valuationView(
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
  ) {
    const lines = await this.valuation.getValuation({ warehouseId, productId });
    const totalLayerCents = lines.reduce((sum, l) => sum + l.layerValueCents, 0);
    const totalAvgCents = lines.reduce(
      (sum, l) => sum + (l.avgCostValueCents ?? 0),
      0,
    );
    return {
      lines,
      summary: {
        totalLayerValueCents: totalLayerCents,
        totalAvgCostValueCents: totalAvgCents,
        driftCents: totalLayerCents - totalAvgCents,
      },
    };
  }

  @Get('cost-layers/:productId')
  async costLayers(
    @Param('productId') productId: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.valuation.getCostLayers(productId, warehouseId);
  }

  @Get('expiring')
  async expiringSoon(@Query('daysAhead') daysAhead?: string) {
    const days = Math.max(Number(daysAhead ?? 30) || 30, 1);
    return this.valuation.getExpiringSoon(days);
  }

  // ─── Mutations: receive / adjust ────────────────────────────────────
  @Post('receive')
  async receiveStock(@Body() body: ReceiveStockBody) {
    return this.stock.receiveStock(body);
  }

  @Post('transfer')
  async transferStock(@Body() body: {
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    qty: number;
    reason?: string;
    performedBy?: string;
    branchCode?: string;
    transferId?: string;
  }) {
    if (!body.productId || !body.fromWarehouseId || !body.toWarehouseId) {
      throw new Error('transfer: productId, fromWarehouseId, toWarehouseId required');
    }
    if (!body.qty || body.qty <= 0) {
      throw new Error('transfer: qty must be > 0');
    }
    return this.stock.transferStock(body);
  }

  @Post('adjust')
  async adjustStock(@Body() body: AdjustStockBody) {
    if (!body.reason || body.reason.trim().length < 3) {
      throw new Error('adjust: reason must be at least 3 characters');
    }
    if (body.qty === 0) {
      throw new Error('adjust: qty must be non-zero');
    }
    return this.stock.applyMove({
      productId: body.productId,
      qty: body.qty,
      moveType: 'adjust',
      fromWarehouseId: body.qty < 0 ? body.warehouseId : undefined,
      toWarehouseId: body.qty > 0 ? body.warehouseId : undefined,
      reason: body.reason,
      approvedBy: body.approvedBy,
      performedBy: body.performedBy,
      branchCode: body.branchCode,
      sourceModule: 'manual',
      sourceId: `adjust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  // ─── Cycle counts ───────────────────────────────────────────────────
  @Post('cycle-counts/open')
  async openCycleCount(@Body() body: OpenCycleCountBody) {
    return this.cycleCount.open(body);
  }

  @Post('cycle-counts/:id/submit')
  async submitCycleCount(
    @Param('id') sessionId: string,
    @Body() body: SubmitCycleCountBody,
  ) {
    return this.cycleCount.submitCount({ sessionId, lines: body.lines });
  }

  @Post('cycle-counts/:id/post')
  async postCycleCount(
    @Param('id') sessionId: string,
    @Body() body: PostCycleCountBody,
  ) {
    return this.cycleCount.post({ sessionId, approvedBy: body.approvedBy });
  }

  @Post('cycle-counts/:id/cancel')
  async cancelCycleCount(
    @Param('id') sessionId: string,
    @Body() body: { reason?: string },
  ) {
    await this.cycleCount.cancel(sessionId, body.reason);
    return { ok: true };
  }

  @Get('cycle-counts/:id')
  async getCycleCount(@Param('id') sessionId: string) {
    const result = await this.cycleCount.getSession(sessionId);
    if (!result) return null;
    return result;
  }

  // ─── Outbox + reconciliation (Batch 5) ─────────────────────────────
  @Get('outbox/stats')
  async outboxStats() {
    return this.outbox.stats();
  }

  @Post('outbox/run')
  async outboxRun(@Body() body: { batchSize?: number }) {
    return this.outboxRelay.run(body?.batchSize ?? 50);
  }

  @Get('reconciliation/drift')
  async reconciliationDrift(@Query('limit') limitRaw?: string) {
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 500);
    return this.reconciliation.recentDrift(limit);
  }

  @Post('reconciliation/run')
  async reconciliationRun() {
    return this.reconciliation.run();
  }

  // ─── helpers ────────────────────────────────────────────────────────
  private async resolveWarehouse(idOrUndef?: string) {
    if (idOrUndef) {
      const [w] = await this.db
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, idOrUndef))
        .limit(1);
      if (w) return w;
    }
    const [main] = await this.db
      .select()
      .from(warehouses)
      .where(eq(warehouses.code, 'MAIN'))
      .limit(1);
    if (!main) throw new Error('No active warehouse — run Phase 3 migration + seed');
    return main;
  }
}
