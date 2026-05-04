import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { PartnersService, type CreatePartnerInput } from '../application/partners.service';
import {
  PurchaseOrdersService,
  type CreatePurchaseOrderInput,
  type PurchaseOrderStatus,
} from '../application/purchase-orders.service';
import {
  GoodsReceiptsService,
  type CreateGoodsReceiptInput,
  type QcStatus,
} from '../application/goods-receipts.service';
import {
  VendorBillsService,
  type CreateVendorBillInput,
  type PayVendorBillInput,
  type RecordPaymentInput,
  type VendorBillStatus,
} from '../application/vendor-bills.service';
import { ApAgingService } from '../application/ap-aging.service';
import { WhtCertificateRenderer } from '../infrastructure/wht-cert.renderer';
import { Roles } from '../../auth/jwt-auth.guard';

type Reply = { type(mime: string): Reply; header(name: string, value: string): Reply; send(body: unknown): void };

/**
 * Role policy:
 *   Partners — anyone authenticated can list/read; manager+ can mutate.
 *   Purchase orders — anyone can list; manager+ can create/confirm/cancel.
 *   Goods receipts — anyone can list; manager+ can create/post/cancel.
 *   Vendor bills — accountant+ for everything (bills carry §86/4 supplier
 *     PII, WHT amounts, GL impact). The 50-Tawi PDF is also accountant+
 *     because the supplier's TIN + address are on the page.
 */
@Controller('api/purchasing')
export class PurchasingController {
  constructor(
    private readonly partners: PartnersService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly goodsReceipts: GoodsReceiptsService,
    private readonly vendorBills: VendorBillsService,
    private readonly apAging: ApAgingService,
    private readonly whtCert: WhtCertificateRenderer,
  ) {}

  // ─── Partners (BP-style) ────────────────────────────────────────────
  @Get('partners')
  listPartners(
    @Query('role') role?: 'supplier' | 'customer' | 'employee',
    @Query('search') search?: string,
  ) {
    return this.partners.list({ role, search });
  }

  @Get('partners/:id')
  getPartner(@Param('id') id: string) {
    return this.partners.findById(id);
  }

  @Post('partners')
  @Roles('admin', 'manager', 'accountant')
  createPartner(@Body() body: CreatePartnerInput) {
    return this.partners.create(body);
  }

  @Patch('partners/:id')
  @Roles('admin', 'manager', 'accountant')
  updatePartner(@Param('id') id: string, @Body() body: Partial<CreatePartnerInput>) {
    return this.partners.update(id, body);
  }

  @Delete('partners/:id')
  @Roles('admin', 'manager')
  async deactivatePartner(@Param('id') id: string) {
    await this.partners.deactivate(id);
    return { ok: true };
  }

  // ─── Purchase Orders ────────────────────────────────────────────────
  @Get('purchase-orders')
  listPos(
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: PurchaseOrderStatus,
    @Query('limit') limit?: string,
  ) {
    return this.purchaseOrders.list({
      supplierId,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('purchase-orders/:id')
  getPo(@Param('id') id: string) {
    return this.purchaseOrders.findById(id);
  }

  @Post('purchase-orders')
  @Roles('admin', 'manager')
  createPo(@Body() body: CreatePurchaseOrderInput) {
    return this.purchaseOrders.create(body);
  }

  @Post('purchase-orders/:id/confirm')
  @Roles('admin', 'manager')
  confirmPo(@Param('id') id: string, @Body() body: { confirmedBy?: string }) {
    return this.purchaseOrders.confirm(id, body.confirmedBy);
  }

  @Post('purchase-orders/:id/cancel')
  @Roles('admin', 'manager')
  cancelPo(
    @Param('id') id: string,
    @Body() body: { reason: string; cancelledBy?: string },
  ) {
    return this.purchaseOrders.cancel(id, body.reason, body.cancelledBy);
  }

  // ─── Goods Receipts ─────────────────────────────────────────────────
  @Get('purchase-orders/:id/grns')
  listGrnsForPo(@Param('id') id: string) {
    return this.goodsReceipts.listForPo(id);
  }

  @Get('grns/:id')
  getGrn(@Param('id') id: string) {
    return this.goodsReceipts.findById(id);
  }

  @Post('grns')
  @Roles('admin', 'manager')
  createGrn(@Body() body: CreateGoodsReceiptInput) {
    return this.goodsReceipts.create(body);
  }

  @Patch('grn-lines/:id/qc')
  @Roles('admin', 'manager')
  setLineQc(
    @Param('id') id: string,
    @Body()
    body: {
      qcStatus: QcStatus;
      qtyAccepted?: number;
      qtyRejected?: number;
      qcNotes?: string;
    },
  ) {
    return this.goodsReceipts.setLineQc({ grnLineId: id, ...body });
  }

  @Post('grns/:id/post')
  @Roles('admin', 'manager')
  postGrn(@Param('id') id: string, @Body() body: { postedBy?: string }) {
    return this.goodsReceipts.post(id, body.postedBy);
  }

  @Post('grns/:id/cancel')
  @Roles('admin', 'manager')
  cancelGrn(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.goodsReceipts.cancel(id, body.reason);
  }

  // ─── Vendor bills (3-way match) — accountant+ ───────────────────────
  @Get('vendor-bills')
  @Roles('admin', 'accountant')
  listBills(
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: VendorBillStatus,
    @Query('limit') limit?: string,
  ) {
    return this.vendorBills.list({
      supplierId,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('vendor-bills/:id')
  @Roles('admin', 'accountant')
  getBill(@Param('id') id: string) {
    return this.vendorBills.findById(id);
  }

  @Post('vendor-bills')
  @Roles('admin', 'accountant')
  createBill(@Body() body: CreateVendorBillInput) {
    return this.vendorBills.create(body);
  }

  @Get('vendor-bills/:id/match')
  @Roles('admin', 'accountant')
  matchBill(@Param('id') id: string) {
    return this.vendorBills.runMatch(id);
  }

  @Post('vendor-bills/:id/post')
  @Roles('admin', 'accountant')
  postBill(
    @Param('id') id: string,
    @Body()
    body: {
      postedBy?: string;
      overrideMatchBy?: string;
      overrideReason?: string;
    } = {},
  ) {
    return this.vendorBills.post(id, body);
  }

  /**
   * Settle the bill in one shot. Equivalent to recordPayment with
   * amountCents = remaining. Kept for back-compat with the original UI flow.
   */
  @Post('vendor-bills/:id/pay')
  @Roles('admin', 'accountant')
  payBill(@Param('id') id: string, @Body() body: PayVendorBillInput = {}) {
    return this.vendorBills.pay(id, body);
  }

  /**
   * Record one installment against a posted/partially-paid bill. The amount
   * must be a positive integer in cents and not exceed the remaining balance.
   * WHT and cash split are computed server-side per §50ทวิ proportional rule.
   */
  @Post('vendor-bills/:id/payments')
  @Roles('admin', 'accountant')
  recordPayment(@Param('id') id: string, @Body() body: RecordPaymentInput) {
    return this.vendorBills.recordPayment(id, body);
  }

  @Get('vendor-bills/:id/payments')
  @Roles('admin', 'accountant')
  listPayments(@Param('id') id: string) {
    return this.vendorBills.listPayments(id);
  }

  /**
   * Void a single payment installment. Inserts a reversing JE and rolls back
   * the bill's running totals + status. Reason ≥3 chars required for audit.
   */
  @Post('vendor-bills/:id/payments/:paymentNo/void')
  @Roles('admin', 'accountant')
  voidPayment(
    @Param('id') id: string,
    @Param('paymentNo') paymentNo: string,
    @Body() body: { reason: string; voidedBy?: string },
  ) {
    return this.vendorBills.voidPayment(
      id,
      Number(paymentNo),
      body.reason,
      body.voidedBy,
    );
  }

  @Post('vendor-bills/:id/void')
  @Roles('admin', 'accountant')
  voidBill(@Param('id') id: string, @Body() body: { reason: string; voidedBy?: string }) {
    return this.vendorBills.void(id, body.reason, body.voidedBy);
  }

  /**
   * AP aging report. As-of defaults to today; current/1-30/31-60/61-90/90+
   * buckets keyed off each bill's effective due date (dueDate ?? billDate +
   * supplier.paymentTermsDays). Only `posted` and `partially_paid` bills
   * contribute — fully paid and voided bills carry no balance.
   */
  @Get('ap-aging')
  @Roles('admin', 'accountant')
  apAgingReport(
    @Query('asOf') asOf?: string,
    @Query('supplierId') supplierId?: string,
  ) {
    return this.apAging.report({ asOf, supplierId });
  }

  /**
   * 🇹🇭 50-Tawi (หนังสือรับรองการหักภาษี ณ ที่จ่าย) — per Revenue Code §50 ทวิ.
   * Returns a printable PDF for the supplier to keep as proof of withholding.
   * Available only when wht_cents > 0; preferred after the bill is paid (the
   * payment date is the WHT tax-point under §50).
   */
  @Get('vendor-bills/:id/wht-cert.pdf')
  @Roles('admin', 'accountant')
  async getWhtCert(@Param('id') id: string, @Res({ passthrough: false }) reply: Reply) {
    const buf = await this.whtCert.renderForBill(id);
    const bill = await this.vendorBills.findById(id);
    const slug = bill?.internalNumber ?? id;
    reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename=50tawi-${slug}.pdf`)
      .send(buf);
  }
}
