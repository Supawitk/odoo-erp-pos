import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService, type ListSalesFilter } from '../application/sales.service';
import {
  SalesInvoicesService,
  type CreateInvoiceInput,
  type RecordReceiptInput,
  type SalesInvoiceStatus,
} from '../application/sales-invoices.service';
import { ArAgingService } from '../application/ar-aging.service';

@Controller('api/sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly invoices: SalesInvoicesService,
    private readonly arAging: ArAgingService,
  ) {}

  // ─── POS-orders read APIs ───────────────────────────────────────────────
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
    return this.sales.listCustomers({
      search,
      limit: limit ? Number(limit) : undefined,
    });
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
    return this.sales.topProducts({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ─── Sales Invoices (credit B2B) ────────────────────────────────────────
  @Post('invoices')
  @HttpCode(201)
  createInvoice(@Body() body: CreateInvoiceInput) {
    if (!body?.customerId) {
      throw new BadRequestException('customerId is required');
    }
    if (!body?.invoiceDate) {
      throw new BadRequestException('invoiceDate (YYYY-MM-DD) is required');
    }
    return this.invoices.create(body);
  }

  @Get('invoices')
  listInvoices(
    @Query('customerId') customerId?: string,
    @Query('status') status?: SalesInvoiceStatus,
    @Query('limit') limit?: string,
  ) {
    return this.invoices.list({
      customerId,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('invoices/:id')
  getInvoice(@Param('id') id: string) {
    return this.invoices.findById(id);
  }

  @Post('invoices/:id/send')
  sendInvoice(@Param('id') id: string, @Body() body: { sentBy?: string } = {}) {
    return this.invoices.send(id, body);
  }

  @Post('invoices/:id/cancel')
  cancelInvoice(
    @Param('id') id: string,
    @Body() body: { reason: string; cancelledBy?: string },
  ) {
    if (!body?.reason || body.reason.trim().length < 3) {
      throw new BadRequestException('Cancellation reason is required (≥3 chars)');
    }
    return this.invoices.cancel(id, body.reason, body.cancelledBy);
  }

  @Post('invoices/:id/receipts')
  @HttpCode(201)
  recordReceipt(
    @Param('id') id: string,
    @Body() body: RecordReceiptInput,
  ) {
    return this.invoices.recordReceipt(id, body);
  }

  @Get('invoices/:id/receipts')
  listReceipts(@Param('id') id: string) {
    return this.invoices.listReceipts(id);
  }

  /**
   * Void a single receipt. Inserts a reversing JE and rolls back the
   * invoice's running totals + status. Reason ≥3 chars required.
   */
  @Post('invoices/:id/receipts/:receiptNo/void')
  voidReceipt(
    @Param('id') id: string,
    @Param('receiptNo') receiptNo: string,
    @Body() body: { reason: string; voidedBy?: string },
  ) {
    return this.invoices.voidReceipt(
      id,
      Number(receiptNo),
      body.reason,
      body.voidedBy,
    );
  }

  // ─── AR aging ───────────────────────────────────────────────────────────
  @Get('ar-aging')
  arAgingReport(
    @Query('asOf') asOf?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.arAging.report({ asOf, customerId });
  }
}
