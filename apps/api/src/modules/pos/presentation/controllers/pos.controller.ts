import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateOrderDto } from '../dtos/create-order.dto';
import { RefundOrderDto } from '../dtos/refund-order.dto';
import { CreateOrderCommand } from '../../application/commands/create-order.command';
import { RefundOrderCommand } from '../../application/commands/refund-order.command';
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
      ),
    );
  }

  @Get('orders')
  listOrders(@Query('sessionId') sessionId?: string, @Query('limit') limit?: string) {
    return this.queryBus.execute(
      new ListOrdersQuery(sessionId, limit ? parseInt(limit, 10) : 20),
    );
  }

  @Post('orders/:id/refund')
  @HttpCode(201)
  @Roles('admin', 'manager')
  async refundOrder(@Param('id') id: string, @Body() dto: RefundOrderDto) {
    return this.commandBus.execute(
      new RefundOrderCommand(id, dto.reason, dto.approvedBy, dto.lines),
    );
  }
}
