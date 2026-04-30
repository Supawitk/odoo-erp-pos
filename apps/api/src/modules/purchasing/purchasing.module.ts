import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PartnersService } from './application/partners.service';
import { PurchaseOrdersService } from './application/purchase-orders.service';
import { GoodsReceiptsService } from './application/goods-receipts.service';
import { VendorBillsService } from './application/vendor-bills.service';
import { PurchasingSequenceService } from './infrastructure/purchasing-sequence.service';
import { PurchasingController } from './presentation/purchasing.controller';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [CqrsModule, AccountingModule],
  controllers: [PurchasingController],
  providers: [
    PartnersService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    VendorBillsService,
    PurchasingSequenceService,
  ],
  exports: [PartnersService, PurchaseOrdersService, GoodsReceiptsService, VendorBillsService],
})
export class PurchasingModule {}
