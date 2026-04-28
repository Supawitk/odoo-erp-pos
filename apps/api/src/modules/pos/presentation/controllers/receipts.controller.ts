import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';

type Reply = { type(mime: string): Reply; header(name: string, value: string): Reply; send(body: unknown): void };

import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { ReceiptRenderer } from '../../infrastructure/receipt.renderer';
import { ReceiptMailerService } from '../../infrastructure/receipt-mailer.service';

@Controller('api/pos/receipts')
export class ReceiptsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly renderer: ReceiptRenderer,
    private readonly mailer: ReceiptMailerService,
  ) {}

  @Get(':orderId.html')
  async receiptHtml(
    @Param('orderId') orderId: string,
    @Res({ passthrough: false }) reply: Reply,
  ): Promise<void> {
    const [order] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException(`order ${orderId}`);
    const html = await this.renderer.render(order);
    reply.type('text/html; charset=utf-8').send(html);
  }

  @Post(':orderId/email')
  async emailReceipt(
    @Param('orderId') orderId: string,
    @Body() body: { to: string },
  ) {
    const [order] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException(`order ${orderId}`);
    const html = await this.renderer.render(order);
    const subject = order.documentNumber
      ? `Receipt ${order.documentNumber}`
      : `Receipt ${orderId.slice(0, 8)}`;
    return this.mailer.sendReceipt({
      to: body.to,
      subject,
      html,
      documentNumber: order.documentNumber,
    });
  }
}
