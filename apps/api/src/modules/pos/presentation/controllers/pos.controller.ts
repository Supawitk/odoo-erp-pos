import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateOrderDto } from '../dtos/create-order.dto';
import { RefundOrderDto } from '../dtos/refund-order.dto';
import { DebitOrderDto } from '../dtos/debit-order.dto';
import { CreateOrderCommand } from '../../application/commands/create-order.command';
import { RefundOrderCommand } from '../../application/commands/refund-order.command';
import { DebitOrderCommand } from '../../application/commands/debit-order.command';
import { ListOrdersQuery } from '../../application/queries/list-orders.query';
import { Roles } from '../../../auth/jwt-auth.guard';

@Controller('api/pos')
export class PosController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post('orders')
  @HttpCode(201)
  async createOrder(@Body() dto: CreateOrderDto) {
    return this.commandBus.execute(
      new CreateOrderCommand(
        dto.offlineId,
        dto.sessionId,
        dto.customerId,
        dto.buyer,
        dto.lines,
        dto.cartDiscountCents ?? 0,
        dto.currency,
        dto.vatMode,
        dto.payment,
        dto.iPadDeviceId,
        dto.orderType ?? null,
        dto.tableNumber ?? null,
        dto.tipCents ?? 0,
        dto.splitParentId ?? null,
      ),
    );
  }

  @Get('orders')
  listOrders(@Query('sessionId') sessionId?: string, @Query('limit') limit?: string) {
    return this.queryBus.execute(
      new ListOrdersQuery(sessionId, limit ? parseInt(limit, 10) : 20),
    );
  }

  /**
   * Single-order lookup. Used by the /approvals deep-link to focus a refund
   * after its tier review is approved — the order may pre-date the current
   * session so it isn't always in the recent-orders strip.
   */
  @Get('orders/:id')
  async getOrder(@Param('id') id: string) {
    const rows = (await this.queryBus.execute(
      new ListOrdersQuery(undefined, 1, id),
    )) as any[];
    if (!rows || rows.length === 0) {
      throw new NotFoundException(`order ${id} not found`);
    }
    return rows[0];
  }

  @Post('orders/:id/refund')
  @HttpCode(201)
  @Roles('admin', 'manager', 'cashier')
  async refundOrder(@Param('id') id: string, @Body() dto: RefundOrderDto) {
    return this.commandBus.execute(
      new RefundOrderCommand(id, dto.reason, dto.approvedBy ?? '', dto.lines),
    );
  }

  /**
   * 🇹🇭 §86/9 Debit Note (ใบเพิ่มหนี้) — additional charges against an
   * already-issued tax invoice. Increases the buyer's payable + the
   * seller's output VAT for the period.
   */
  @Post('orders/:id/debit-note')
  @HttpCode(201)
  @Roles('admin', 'manager')
  async debitOrder(@Param('id') id: string, @Body() dto: DebitOrderDto) {
    return this.commandBus.execute(
      new DebitOrderCommand(id, dto.reason, dto.lines, dto.approvedBy),
    );
  }
}
