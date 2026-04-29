import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler, EventBus } from '@nestjs/cqrs';
import { eq, inArray } from 'drizzle-orm';
import { posOrders, products, stockMoves, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrderCompletedEvent } from '../../../pos/domain/events';
import { OrderStockConsumedEvent } from '../../domain/events';
import { StockService } from '../stock.service';
import { InsufficientStockError } from '../../domain/errors';

/**
 * POS sale → stock deduction.
 *
 * Triggered by `OrderCompletedEvent` (published by both create-order and
 * refund-order handlers). Re-fetches the order to get its line items + doc
 * type, then calls StockService.applyMove for each line.
 *
 * Move type per order document:
 *   - RE / ABB / TX → 'sale'   (qty negative, deducts stock)
 *   - CN            → 'refund' (qty positive, returns stock)
 *
 * Idempotency: StockService keys on (source_module='pos', source_id=`${orderId}:${productId}`).
 * Replays are no-ops; concurrent retries collapse via the UNIQUE on stock_moves.
 *
 * Failure mode: if a line throws InsufficientStockError, we log + continue —
 * an order has already been persisted (Phase 2 invariant), so refusing to
 * deduct would orphan the sale. Negative qty is allowed via approvedBy='SYSTEM'
 * because the merchant clearly sold something they shouldn't have had — the
 * cycle-count workflow will surface the variance.
 */
@Injectable()
@EventsHandler(OrderCompletedEvent)
export class OnOrderCompletedStockHandler implements IEventHandler<OrderCompletedEvent> {
  private readonly logger = new Logger(OnOrderCompletedStockHandler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly stock: StockService,
    private readonly eventBus: EventBus,
  ) {}

  async handle(event: OrderCompletedEvent): Promise<void> {
    const [order] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, event.orderId))
      .limit(1);

    if (!order) {
      this.logger.warn(`Order ${event.orderId} not found — skipping stock deduction`);
      return;
    }

    const isRefund = order.documentType === 'CN';
    const moveType: 'sale' | 'refund' = isRefund ? 'refund' : 'sale';
    const lines = (order.orderLines as Array<{
      productId: string;
      qty: number;
      name?: string;
    }>) || [];

    const warehouseId = await this.stock.resolveMainWarehouse();

    // Snapshot the moving-average cost per product at sale time so the move
    // row carries a cost basis. The accounting COGS handler reads this back
    // to post Dr 5100 / Cr 1161. Products with no avg cost yet (never
    // received) record null and the COGS journal is skipped — the goods
    // report cycle-count flow will surface the variance.
    const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
    const costMap = new Map<string, number | null>();
    if (productIds.length > 0) {
      const rows = await this.db
        .select({ id: products.id, avg: products.avgCostCents })
        .from(products)
        .where(inArray(products.id, productIds));
      for (const r of rows) {
        costMap.set(r.id, r.avg == null ? null : Number(r.avg));
      }
    }

    let succeeded = 0;
    let failed = 0;
    for (const line of lines) {
      if (!line.productId) {
        this.logger.warn(`Order ${event.orderId} has a line without productId — skipping`);
        continue;
      }
      // CN lines are stored with negative qty in our refund handler. Sale qty
      // should DECREMENT stock; refund qty should INCREMENT stock.
      const signedQty = isRefund ? Math.abs(line.qty) : -Math.abs(line.qty);
      const avgCost = costMap.get(line.productId) ?? null;

      try {
        await this.stock.applyMove({
          productId: line.productId,
          qty: signedQty,
          moveType,
          fromWarehouseId: !isRefund ? warehouseId : undefined,
          toWarehouseId: isRefund ? warehouseId : undefined,
          // Stamp moving-average cost so accounting can post COGS.
          unitCostCents: avgCost ?? undefined,
          sourceModule: 'pos',
          sourceId: `${order.id}:${line.productId}`,
          reference: order.documentNumber ?? order.id,
          performedBy: order.iPadDeviceId ?? undefined,
          // Sales auto-approve to never block a paid order. Variance becomes
          // visible in the cycle-count + daily goods report flow.
          approvedBy: 'SYSTEM',
          branchCode: order.buyerBranch ?? undefined,
        });
        succeeded += 1;
      } catch (e) {
        failed += 1;
        if (e instanceof InsufficientStockError) {
          // Won't happen with approvedBy='SYSTEM' but kept for safety.
          this.logger.warn(
            `InsufficientStock on ${event.orderId}/${line.productId}: ${e.message}`,
          );
        } else {
          this.logger.error(
            `Stock move failed for ${event.orderId}/${line.productId}: ${(e as Error).message}`,
          );
        }
      }
    }

    this.logger.log(
      `Order ${event.orderId} [${order.documentType}] stock applied: ${succeeded} ok, ${failed} failed (of ${lines.length})`,
    );

    // ─── Aggregate cost basis and fan out to accounting (COGS posting) ─────
    // Re-read stock_moves so we capture the actual layer-weighted unit cost
    // recorded by applyMove (a single line can split across cost layers under
    // FIFO/FEFO; each split becomes its own move row).
    if (succeeded > 0) {
      const orderMoves = await this.db
        .select({
          qty: stockMoves.qty,
          unitCostCents: stockMoves.unitCostCents,
          sourceId: stockMoves.sourceId,
        })
        .from(stockMoves)
        .where(eq(stockMoves.sourceModule, 'pos'));

      let totalCost = 0;
      let costed = 0;
      for (const m of orderMoves) {
        if (!m.sourceId?.startsWith(`${order.id}:`)) continue;
        const u = Number(m.unitCostCents ?? 0);
        const q = Math.abs(Number(m.qty ?? 0));
        if (u > 0 && q > 0) {
          totalCost += Math.round(u * q);
          costed += 1;
        }
      }

      if (totalCost > 0) {
        this.eventBus.publish(
          new OrderStockConsumedEvent(
            order.id,
            totalCost,
            isRefund,
            costed,
            order.currency,
            new Date(),
          ),
        );
      } else {
        this.logger.log(
          `Order ${event.orderId}: no cost basis recorded (zero-cost product or stock not yet costed) — skipping COGS event`,
        );
      }
    }
  }
}
