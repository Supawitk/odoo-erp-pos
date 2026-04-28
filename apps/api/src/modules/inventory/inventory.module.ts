import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { StockService } from './application/stock.service';
import { ValuationService } from './application/valuation.service';
import { CycleCountService } from './application/cycle-count.service';
import { OnOrderCompletedStockHandler } from './application/events/on-order-completed-stock.handler';
import { OnLowStockHandler } from './application/events/on-low-stock.handler';
import { OnGoodsReceivedHandler } from './application/events/on-goods-received.handler';
import { OnStockMovedOutboxHandler } from './application/events/on-stock-moved-outbox.handler';
import { ExpiryCronService } from './infrastructure/expiry-cron.service';
import { OutboxService } from './infrastructure/outbox.service';
import { OutboxRelayService } from './infrastructure/outbox-relay.service';
import { OdooCatalogPullService } from './infrastructure/odoo-catalog-pull.service';
import { ReconciliationCronService } from './infrastructure/reconciliation-cron.service';
import { InventoryController } from './presentation/inventory.controller';
import { PosModule } from '../pos/pos.module';

@Module({
  imports: [CqrsModule, PosModule],
  controllers: [InventoryController],
  providers: [
    StockService,
    ValuationService,
    CycleCountService,
    OnOrderCompletedStockHandler,
    OnLowStockHandler,
    OnGoodsReceivedHandler,
    OnStockMovedOutboxHandler,
    ExpiryCronService,
    OutboxService,
    OutboxRelayService,
    OdooCatalogPullService,
    ReconciliationCronService,
  ],
  exports: [
    StockService,
    ValuationService,
    CycleCountService,
    OutboxService,
    OutboxRelayService,
    ReconciliationCronService,
  ],
})
export class InventoryModule {}
