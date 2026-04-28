import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { OrderCompletedEvent } from '../../domain/events';
import { PosGateway } from '../../presentation/gateways/pos.gateway';

/**
 * Translates domain event -> wire event broadcast.
 * Kept intentionally dumb — no business logic, just fanout.
 * Accounting / inventory will each add their own handlers for the same event.
 */
@EventsHandler(OrderCompletedEvent)
export class OnOrderCompletedBroadcast implements IEventHandler<OrderCompletedEvent> {
  private readonly logger = new Logger(OnOrderCompletedBroadcast.name);

  constructor(private readonly gateway: PosGateway) {}

  handle(event: OrderCompletedEvent) {
    const messageId = uuidv7();
    this.gateway.broadcastOrderCompleted({
      messageId,
      orderId: event.orderId,
      sessionId: event.sessionId,
      totalCents: event.totalCents,
      currency: event.currency,
      occurredAt: event.createdAt,
    });
    this.logger.log(`pos:order:created emitted messageId=${messageId} orderId=${event.orderId}`);
  }
}
