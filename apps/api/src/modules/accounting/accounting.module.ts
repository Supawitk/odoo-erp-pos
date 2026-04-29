import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AccountingController } from './presentation/accounting.controller';
import { JournalRepository } from './infrastructure/journal.repository';
import { CoaSeederService } from './infrastructure/coa.seeder';
import { AccountingService } from './application/services/accounting.service';
import { OnOrderCompletedJournalHandler } from './application/events/on-order-completed-journal.handler';

@Module({
  imports: [CqrsModule],
  controllers: [AccountingController],
  providers: [
    JournalRepository,
    AccountingService,
    CoaSeederService,
    OnOrderCompletedJournalHandler,
  ],
  exports: [JournalRepository, AccountingService],
})
export class AccountingModule {}
