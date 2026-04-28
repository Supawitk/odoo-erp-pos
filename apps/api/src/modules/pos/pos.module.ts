import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PosController } from './presentation/controllers/pos.controller';
import { SessionsController } from './presentation/controllers/sessions.controller';
import { ReceiptsController } from './presentation/controllers/receipts.controller';
import { HeldCartsController } from './presentation/controllers/held-carts.controller';
import { HeldCartsService } from './application/held-carts.service';
import { PosGateway } from './presentation/gateways/pos.gateway';
import { ReceiptRenderer } from './infrastructure/receipt.renderer';
import { CreateOrderHandler } from './application/commands/create-order.handler';
import { RefundOrderHandler } from './application/commands/refund-order.handler';
import {
  OpenSessionHandler,
  CloseSessionHandler,
} from './application/commands/session.handlers';
import {
  GetCurrentSessionHandler,
  GetSessionSummaryHandler,
  GetSessionsDashboardHandler,
} from './application/queries/session.queries';
import { ListOrdersHandler } from './application/queries/list-orders.query';
import { OnOrderCompletedBroadcast } from './application/events/on-order-completed.handler';
import { OnOrderCompletedOdooSync } from './application/events/on-order-completed-odoo-sync.handler';
import { DocumentSequenceService } from './infrastructure/document-sequence.service';
import { SessionSweeperService } from './infrastructure/session-sweeper.service';
import { ReceiptMailerService } from './infrastructure/receipt-mailer.service';

@Module({
  imports: [CqrsModule],
  controllers: [PosController, SessionsController, ReceiptsController, HeldCartsController],
  providers: [
    CreateOrderHandler,
    RefundOrderHandler,
    OpenSessionHandler,
    CloseSessionHandler,
    GetCurrentSessionHandler,
    GetSessionSummaryHandler,
    GetSessionsDashboardHandler,
    ListOrdersHandler,
    OnOrderCompletedBroadcast,
    OnOrderCompletedOdooSync,
    PosGateway,
    DocumentSequenceService,
    ReceiptRenderer,
    ReceiptMailerService,
    SessionSweeperService,
    HeldCartsService,
  ],
  exports: [PosGateway],
})
export class PosModule {}
