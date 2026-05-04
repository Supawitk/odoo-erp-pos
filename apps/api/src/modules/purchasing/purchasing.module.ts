import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PartnersService } from './application/partners.service';
import { PurchaseOrdersService } from './application/purchase-orders.service';
import { GoodsReceiptsService } from './application/goods-receipts.service';
import { VendorBillsService } from './application/vendor-bills.service';
import { ApAgingService } from './application/ap-aging.service';
import { PurchasingSequenceService } from './infrastructure/purchasing-sequence.service';
import { WhtCertificateRenderer } from './infrastructure/wht-cert.renderer';
import { PurchasingController } from './presentation/purchasing.controller';
import { AccountingModule } from '../accounting/accounting.module';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [CqrsModule, AccountingModule, OrganizationModule],
  controllers: [PurchasingController],
  providers: [
    PartnersService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    VendorBillsService,
    ApAgingService,
    PurchasingSequenceService,
    WhtCertificateRenderer,
  ],
  exports: [
    PartnersService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    VendorBillsService,
    ApAgingService,
  ],
})
export class PurchasingModule {}
