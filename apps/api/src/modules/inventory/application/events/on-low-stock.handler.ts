import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';
import { LowStockAlertEvent } from '../../domain/events';
import { PosGateway } from '../../../pos/presentation/gateways/pos.gateway';

/**
 * Listens for LowStockAlertEvent (published by StockService when qty drops to
 * or below products.reorder_point). Broadcasts to web dashboard + iPad so the
 * UI can surface a banner / badge.
 */
@Injectable()
@EventsHandler(LowStockAlertEvent)
export class OnLowStockHandler implements IEventHandler<LowStockAlertEvent> {
  private readonly logger = new Logger(OnLowStockHandler.name);

  constructor(private readonly gateway: PosGateway) {}

  handle(event: LowStockAlertEvent): void {
    const messageId = uuidv7();
    this.logger.warn(
      `Low stock: ${event.productName} (${event.productId}) at warehouse ${event.warehouseId} = ${event.qtyOnHand} ≤ reorder ${event.reorderPoint}`,
    );
    this.gateway.broadcastLowStock({
      messageId,
      productId: event.productId,
      productName: event.productName,
      warehouseId: event.warehouseId,
      qtyOnHand: event.qtyOnHand,
      reorderPoint: event.reorderPoint,
      suggestedReorderQty: event.suggestedReorderQty,
      occurredAt: event.occurredAt,
    });
  }
}
