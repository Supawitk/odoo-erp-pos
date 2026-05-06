import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AccountingController } from './presentation/accounting.controller';
import { JournalRepository } from './infrastructure/journal.repository';
import { CoaSeederService } from './infrastructure/coa.seeder';
import { AccountingService } from './application/services/accounting.service';
import { FinancialStatementsService } from './application/financial-statements.service';
import { OnOrderCompletedJournalHandler } from './application/events/on-order-completed-journal.handler';
import { OnStockConsumedCogsHandler } from './application/events/on-stock-consumed-cogs.handler';
import { PosJournalBackfillService } from './application/pos-journal-backfill.service';
import { FixedAssetsService } from './application/fixed-assets.service';
import { DepreciationCronService } from './infrastructure/depreciation.cron';
import { PeriodCloseService } from './application/services/period-close.service';
import { OdooModule } from '../../shared/infrastructure/odoo/odoo.module';

@Module({
  imports: [CqrsModule, OdooModule],
  controllers: [AccountingController],
  providers: [
    JournalRepository,
    AccountingService,
    FinancialStatementsService,
    CoaSeederService,
    OnOrderCompletedJournalHandler,
    OnStockConsumedCogsHandler,
    PosJournalBackfillService,
    FixedAssetsService,
    DepreciationCronService,
    PeriodCloseService,
  ],
  exports: [
    JournalRepository,
    AccountingService,
    FinancialStatementsService,
    PosJournalBackfillService,
    FixedAssetsService,
    PeriodCloseService,
  ],
})
export class AccountingModule {}
