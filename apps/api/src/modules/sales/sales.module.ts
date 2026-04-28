import { Module } from '@nestjs/common';
import { SalesService } from './application/sales.service';
import { SalesController } from './presentation/sales.controller';

@Module({
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
