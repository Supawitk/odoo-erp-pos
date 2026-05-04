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

@Module({
  imports: [CqrsModule],
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
  ],
  exports: [
    JournalRepository,
    AccountingService,
    FinancialStatementsService,
    PosJournalBackfillService,
    FixedAssetsService,
  ],
})
export class AccountingModule {}
