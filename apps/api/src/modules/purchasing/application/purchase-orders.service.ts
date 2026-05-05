import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { computeThaiVat, type ThaiVatCategory, type ThaiVatMode } from '@erp/shared';
import {
  partners,
  purchaseOrderAmendments,
  purchaseOrderLines,
  purchaseOrders,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { PurchaseOrderConfirmedEvent } from '../domain/events';
import { PurchaseOrderStateError } from '../domain/errors';
import { PurchasingSequenceService } from '../infrastructure/purchasing-sequence.service';
import { OrganizationService } from '../../organization/organization.service';
import { TierValidationService } from '../../approvals/tier-validation.service';

export type PurchaseOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'partial_received'
  | 'received'
  | 'cancelled';

export interface CreatePurchaseOrderInput {
  supplierId: string;
  destinationWarehouseId: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
  currency?: string;
  fxRateToThb?: number;
  vatMode?: ThaiVatMode;
  notes?: string;
  createdBy?: string;
  lines: Array<{
    productId: string;
    description?: string;
    qtyOrdered: number;
    unitPriceCents: number;
    discountCents?: number;
    vatCategory?: ThaiVatCategory;
    exciseCents?: number;
  }>;
}

const TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['partial_received', 'received', 'cancelled'],
  partial_received: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly seq: PurchasingSequenceService,
    private readonly eventBus: EventBus,
    private readonly org: OrganizationService,
    private readonly tier: TierValidationService,
  ) {}

  /**
   * Create a draft PO. Computes line totals and VAT breakdown using the same
   * Thai VAT engine the POS uses, so PO totals reconcile against vendor bills
   * downstream.
   */
  async create(input: CreatePurchaseOrderInput) {
    if (input.lines.length === 0) throw new Error('PO must have at least one line');

    const supplier = await this.db
      .select({ id: partners.id, isSupplier: partners.isSupplier })
      .from(partners)
      .where(eq(partners.id, input.supplierId))
      .limit(1);
    if (!supplier[0] || !supplier[0].isSupplier) {
      throw new Error(`Partner ${input.supplierId} is not flagged as supplier`);
    }

    const vatMode: ThaiVatMode = input.vatMode ?? 'exclusive';
    const vatLines = input.lines.map((l, i) => {
      const lineGross = l.qtyOrdered * l.unitPriceCents - (l.discountCents ?? 0);
      const exciseCents = l.exciseCents ?? 0;
      // Accept both DB-style 'zero' and engine-style 'zero_rated' for consistency
      // with the POS create-order handler. Anything else is treated as standard.
      const raw = (l.vatCategory ?? 'standard') as string;
      const category: ThaiVatCategory =
        raw === 'zero' || raw === 'zero_rated'
          ? 'zero_rated'
          : raw === 'exempt'
            ? 'exempt'
            : 'standard';
      return {
        id: `po-line-${i}`,
        amountCents: lineGross + exciseCents,
        category,
      };
    });

    // VAT rate from org settings (no longer hardcoded 0.07). Falls to 0 if
    // the merchant isn't VAT-registered, mirroring the POS create-order
    // handler so PO totals match downstream invoices for the same customer.
    const settings = await this.org.snapshot();
    const vatRate = settings.vatRegistered ? settings.vatRate : 0;
    const vatRes = computeThaiVat(vatLines, { defaultMode: vatMode, rate: vatRate });

    const allocated = await this.seq.allocate('PO', new Date(input.orderDate ?? Date.now()));

    const poId = uuidv7();
    const subtotal = vatRes.perLine.reduce((s, p) => s + p.netCents, 0);
    const totalDiscount = input.lines.reduce((s, l) => s + (l.discountCents ?? 0), 0);
    const grandTotal = vatRes.grossCents;

    return this.db.transaction(async (tx) => {
      await tx.insert(purchaseOrders).values({
        id: poId,
        poNumber: allocated.number,
        supplierId: input.supplierId,
        status: 'draft',
        orderDate: input.orderDate ?? new Date().toISOString().slice(0, 10),
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        destinationWarehouseId: input.destinationWarehouseId,
        currency: input.currency ?? 'THB',
        fxRateToThb: String(input.fxRateToThb ?? 1.0),
        vatMode,
        subtotalCents: subtotal,
        discountCents: totalDiscount,
        vatCents: vatRes.vatCents,
        totalCents: grandTotal,
        vatBreakdown: vatRes,
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
      });

      await tx.insert(purchaseOrderLines).values(
        input.lines.map((l, i) => {
          const lineGross = l.qtyOrdered * l.unitPriceCents - (l.discountCents ?? 0);
          return {
            id: uuidv7(),
            purchaseOrderId: poId,
            lineNo: i + 1,
            productId: l.productId,
            description: l.description ?? null,
            qtyOrdered: String(l.qtyOrdered),
            qtyReceived: '0',
            unitPriceCents: l.unitPriceCents,
            discountCents: l.discountCents ?? 0,
            vatCategory: l.vatCategory ?? 'standard',
            exciseCents: l.exciseCents ?? 0,
            lineTotalCents: lineGross,
          };
        }),
      );

      this.logger.log(`PO ${allocated.number} created — supplier=${input.supplierId} lines=${input.lines.length} total=${subtotal}`);
      return await this.findByIdInTx(tx, poId);
    });
  }

  async findById(id: string) {
    const [po] = await this.db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .limit(1);
    if (!po) return null;
    const lines = await this.db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    return { ...po, lines };
  }

  private async findByIdInTx(tx: any, id: string) {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .limit(1);
    if (!po) return null;
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    return { ...po, lines };
  }

  async list(opts?: { supplierId?: string; status?: PurchaseOrderStatus; limit?: number }) {
    const conds = [];
    if (opts?.supplierId) conds.push(eq(purchaseOrders.supplierId, opts.supplierId));
    if (opts?.status) conds.push(eq(purchaseOrders.status, opts.status));
    return this.db
      .select()
      .from(purchaseOrders)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.createdAt))
      .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 500));
  }

  async confirm(id: string, confirmedBy?: string, approvedBy?: string) {
    // Read first OUTSIDE the tx so the tier check has the totals to evaluate.
    const [poForGate] = await this.db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .limit(1);
    if (!poForGate) throw new Error(`PO ${id} not found`);
    await this.tier.assertApproved({
      kind: 'po.confirm',
      targetId: id,
      context: {
        amount: poForGate.totalCents,
        currency: poForGate.currency,
        supplierId: poForGate.supplierId,
      },
      requestedBy: confirmedBy,
      preApprovedBy: approvedBy,
    });

    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, id))
        .limit(1);
      if (!po) throw new Error(`PO ${id} not found`);
      if (!TRANSITIONS[po.status as PurchaseOrderStatus].includes('confirmed')) {
        throw new PurchaseOrderStateError(id, po.status, 'confirmed');
      }

      await tx
        .update(purchaseOrders)
        .set({
          status: 'confirmed',
          confirmedBy: confirmedBy ?? null,
          confirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, id));

      this.eventBus.publish(
        new PurchaseOrderConfirmedEvent(
          po.id,
          po.poNumber,
          po.supplierId,
          po.totalCents,
          po.currency,
          new Date(),
        ),
      );
      this.logger.log(`PO ${po.poNumber} confirmed by ${confirmedBy ?? '(unknown)'}`);
      return { id: po.id, status: 'confirmed' };
    });
  }

  async cancel(id: string, reason: string, cancelledBy?: string) {
    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, id))
        .limit(1);
      if (!po) throw new Error(`PO ${id} not found`);
      if (!TRANSITIONS[po.status as PurchaseOrderStatus].includes('cancelled')) {
        throw new PurchaseOrderStateError(id, po.status, 'cancelled');
      }

      await tx
        .update(purchaseOrders)
        .set({
          status: 'cancelled',
          cancelledBy: cancelledBy ?? null,
          cancelledAt: new Date(),
          cancellationReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, id));

      this.logger.log(`PO ${po.poNumber} cancelled by ${cancelledBy ?? '(unknown)'}: ${reason}`);
      return { id: po.id, status: 'cancelled' };
    });
  }

  /**
   * Recompute partial_received / received status by summing up GRN qtyAccepted
   * per line and comparing to qtyOrdered. Called by the GRN service after it
   * posts a receipt.
   */
  async recomputeReceiptStatus(poId: string): Promise<PurchaseOrderStatus> {
    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, poId))
        .limit(1);
      if (!po) throw new Error(`PO ${poId} not found`);

      const lines = await tx
        .select({
          id: purchaseOrderLines.id,
          qtyOrdered: purchaseOrderLines.qtyOrdered,
          qtyReceived: purchaseOrderLines.qtyReceived,
        })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, poId));

      let allFull = true;
      let anyReceived = false;
      for (const line of lines) {
        const ordered = Number(line.qtyOrdered);
        const received = Number(line.qtyReceived);
        if (received > 0) anyReceived = true;
        if (received < ordered) allFull = false;
      }

      let next: PurchaseOrderStatus = po.status as PurchaseOrderStatus;
      if (allFull) next = 'received';
      else if (anyReceived) next = 'partial_received';

      if (next !== po.status) {
        await tx
          .update(purchaseOrders)
          .set({ status: next, updatedAt: new Date() })
          .where(eq(purchaseOrders.id, poId));
        this.logger.log(`PO ${po.poNumber} status: ${po.status} → ${next}`);
      }
      return next;
    });
  }

  /**
   * Record an amendment (immutable audit). Required for §65 CIT deductibility
   * evidence — every PO change must be traceable.
   */
  async recordAmendment(input: {
    purchaseOrderId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    reason?: string;
    amendedBy?: string;
  }) {
    const versionRow = await this.db.execute<{ version: number }>(sql`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM custom.purchase_order_amendments
       WHERE purchase_order_id = ${input.purchaseOrderId}
    `);
    const version =
      Number((versionRow as any)[0]?.version ?? (versionRow as any).rows?.[0]?.version ?? 1);

    await this.db.insert(purchaseOrderAmendments).values({
      purchaseOrderId: input.purchaseOrderId,
      version,
      field: input.field,
      oldValue: input.oldValue,
      newValue: input.newValue,
      reason: input.reason ?? null,
      amendedBy: input.amendedBy ?? null,
    });
  }
}
