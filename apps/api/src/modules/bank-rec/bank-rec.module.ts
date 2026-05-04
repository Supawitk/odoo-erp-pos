import { Module } from '@nestjs/common';
import { BankRecService } from './application/bank-rec.service';
import { BankRecController } from './presentation/bank-rec.controller';

@Module({
  controllers: [BankRecController],
  providers: [BankRecService],
  exports: [BankRecService],
})
export class BankRecModule {}
