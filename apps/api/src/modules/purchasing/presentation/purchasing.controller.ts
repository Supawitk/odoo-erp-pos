import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
  type VendorBillStatus,
} from '../application/vendor-bills.service';

@Controller('api/purchasing')
export class PurchasingController {
  constructor(
    private readonly partners: PartnersService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly goodsReceipts: GoodsReceiptsService,
    private readonly vendorBills: VendorBillsService,
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
  createPartner(@Body() body: CreatePartnerInput) {
    return this.partners.create(body);
  }

  @Patch('partners/:id')
  updatePartner(@Param('id') id: string, @Body() body: Partial<CreatePartnerInput>) {
    return this.partners.update(id, body);
  }

  @Delete('partners/:id')
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
  createPo(@Body() body: CreatePurchaseOrderInput) {
    return this.purchaseOrders.create(body);
  }

  @Post('purchase-orders/:id/confirm')
  confirmPo(@Param('id') id: string, @Body() body: { confirmedBy?: string }) {
    return this.purchaseOrders.confirm(id, body.confirmedBy);
  }

  @Post('purchase-orders/:id/cancel')
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
  createGrn(@Body() body: CreateGoodsReceiptInput) {
    return this.goodsReceipts.create(body);
  }

  @Patch('grn-lines/:id/qc')
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
  postGrn(@Param('id') id: string, @Body() body: { postedBy?: string }) {
    return this.goodsReceipts.post(id, body.postedBy);
  }

  @Post('grns/:id/cancel')
  cancelGrn(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.goodsReceipts.cancel(id, body.reason);
  }

  // ─── Vendor bills (3-way match) ─────────────────────────────────────
  @Get('vendor-bills')
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
  getBill(@Param('id') id: string) {
    return this.vendorBills.findById(id);
  }

  @Post('vendor-bills')
  createBill(@Body() body: CreateVendorBillInput) {
    return this.vendorBills.create(body);
  }

  @Get('vendor-bills/:id/match')
  matchBill(@Param('id') id: string) {
    return this.vendorBills.runMatch(id);
  }

  @Post('vendor-bills/:id/post')
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

  @Post('vendor-bills/:id/pay')
  payBill(@Param('id') id: string, @Body() body: PayVendorBillInput = {}) {
    return this.vendorBills.pay(id, body);
  }

  @Post('vendor-bills/:id/void')
  voidBill(@Param('id') id: string, @Body() body: { reason: string; voidedBy?: string }) {
    return this.vendorBills.void(id, body.reason, body.voidedBy);
  }
}
