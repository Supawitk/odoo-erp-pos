import { Controller, Get, Param, Query } from '@nestjs/common';
import { SalesService, type ListSalesFilter } from '../application/sales.service';

@Controller('api/sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('orders')
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('documentType') documentType?: ListSalesFilter['documentType'],
    @Query('status') status?: ListSalesFilter['status'],
    @Query('paymentMethod') paymentMethod?: ListSalesFilter['paymentMethod'],
    @Query('buyerTin') buyerTin?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.sales.listSales({
      from,
      to,
      documentType,
      status,
      paymentMethod,
      buyerTin,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('orders/:id')
  getOne(@Param('id') id: string) {
    return this.sales.getSale(id);
  }

  @Get('customers')
  customers(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.sales.listCustomers({ search, limit: limit ? Number(limit) : undefined });
  }

  @Get('summary/daily')
  dailySummary(@Query('from') from: string, @Query('to') to: string) {
    return this.sales.dailySummary({ from, to });
  }

  @Get('summary/top-products')
  topProducts(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('limit') limit?: string,
  ) {
    return this.sales.topProducts({ from, to, limit: limit ? Number(limit) : undefined });
  }
}
