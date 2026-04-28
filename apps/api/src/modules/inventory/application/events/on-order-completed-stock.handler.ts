import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { eq } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrderCompletedEvent } from '../../../pos/domain/events';
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

      try {
        await this.stock.applyMove({
          productId: line.productId,
          qty: signedQty,
          moveType,
          fromWarehouseId: !isRefund ? warehouseId : undefined,
          toWarehouseId: isRefund ? warehouseId : undefined,
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
  }
}
