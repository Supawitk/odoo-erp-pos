import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { MeiliService } from './meili.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, MeiliService],
  exports: [ProductsService, MeiliService],
})
export class ProductsModule {}
