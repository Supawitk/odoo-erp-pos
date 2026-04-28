import { Module, forwardRef } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PartnersService } from './application/partners.service';
import { PurchaseOrdersService } from './application/purchase-orders.service';
import { GoodsReceiptsService } from './application/goods-receipts.service';
import { PurchasingSequenceService } from './infrastructure/purchasing-sequence.service';
import { PurchasingController } from './presentation/purchasing.controller';

@Module({
  imports: [CqrsModule],
  controllers: [PurchasingController],
  providers: [
    PartnersService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    PurchasingSequenceService,
  ],
  exports: [PartnersService, PurchaseOrdersService, GoodsReceiptsService],
})
export class PurchasingModule {}
