import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { StockMovedEvent } from '../../domain/events';
import { OutboxService } from '../../infrastructure/outbox.service';

/**
 * Listens for StockMovedEvent and writes a stock.move row to the Odoo outbox.
 *
 * external_id format: `erp_pos.stock_move_<moveId>` — Odoo's `ir.model.data`
 * uses this as the idempotency key. Replays are no-ops because the outbox
 * row's UNIQUE constraint on external_id rejects duplicates.
 */
@Injectable()
@EventsHandler(StockMovedEvent)
export class OnStockMovedOutboxHandler implements IEventHandler<StockMovedEvent> {
  private readonly logger = new Logger(OnStockMovedOutboxHandler.name);

  constructor(private readonly outbox: OutboxService) {}

  async handle(event: StockMovedEvent): Promise<void> {
    const externalId = `erp_pos.stock_move_${event.moveId}`;
    await this.outbox.enqueue({
      model: 'stock.move',
      operation: 'create',
      payload: {
        // Odoo `stock.move` create payload — minimal fields. Phase 5 reconciliation
        // will compare local qty vs Odoo qty using product_id + location_id pair.
        name: `[ERP-POS] ${event.moveType} ${event.qty}`,
        product_id: { external_ref: event.productId }, // mapped by relay to Odoo product.product id
        product_uom_qty: Math.abs(event.qty),
        // location maps via warehouse external_ref; Phase 5 cron resolves
        location_from_external_ref: event.fromWarehouseId,
        location_to_external_ref: event.toWarehouseId,
        date_done: event.performedAt.toISOString(),
        origin: event.sourceModule && event.sourceId
          ? `${event.sourceModule}:${event.sourceId}`
          : undefined,
        // ERP-POS metadata for relay-side mapping.
        _erp_meta: {
          moveId: event.moveId,
          moveType: event.moveType,
          qtySigned: event.qty,
          unitCostCents: event.unitCostCents,
        },
      },
      externalId,
    });
    this.logger.debug(`Outbox enqueued: ${externalId} (${event.moveType} qty=${event.qty})`);
  }
}
