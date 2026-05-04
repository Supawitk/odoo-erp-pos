import { Module } from '@nestjs/common';
import { SalesService } from './application/sales.service';
import { SalesInvoicesService } from './application/sales-invoices.service';
import { ArAgingService } from './application/ar-aging.service';
import { SalesSequenceService } from './infrastructure/sales-sequence.service';
import { SalesController } from './presentation/sales.controller';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [AccountingModule],
  controllers: [SalesController],
  providers: [
    SalesService,
    SalesInvoicesService,
    ArAgingService,
    SalesSequenceService,
  ],
  exports: [SalesService, SalesInvoicesService, ArAgingService],
})
export class SalesModule {}
