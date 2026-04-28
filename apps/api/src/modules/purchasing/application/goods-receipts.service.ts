import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  goodsReceiptLines,
  goodsReceipts,
  partners,
  purchaseOrderLines,
  purchaseOrders,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { GoodsReceivedEvent } from '../domain/events';
import {
  GoodsReceiptStateError,
  GrnQuantityExceedsPoError,
} from '../domain/errors';
import { PurchasingSequenceService } from '../infrastructure/purchasing-sequence.service';
import { PurchaseOrdersService } from './purchase-orders.service';

export type QcStatus = 'pending' | 'passed' | 'failed' | 'quarantine';
export type GoodsReceiptStatus = 'draft' | 'posted' | 'cancelled';

export interface CreateGoodsReceiptInput {
  purchaseOrderId: string;
  receivedDate?: string;
  supplierDeliveryNote?: string;
  receivedBy?: string;
  notes?: string;
  lines: Array<{
    purchaseOrderLineId: string;
    qtyReceived: number;
    qtyAccepted?: number; // defaults to qtyReceived when QC passed
    qtyRejected?: number;
    qcStatus?: QcStatus;
    qcNotes?: string;
    unitCostCents?: number; // override; defaults to PO line price
    lotCode?: string;
    serialNo?: string;
    expiryDate?: string;
  }>;
}

@Injectable()
export class GoodsReceiptsService {
  private readonly logger = new Logger(GoodsReceiptsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly seq: PurchasingSequenceService,
    private readonly eventBus: EventBus,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  /**
   * Create a draft GRN against a confirmed (or partially-received) PO.
   * Quantity invariant: per-line qty_received(GRN) + already_received(PO) ≤ qty_ordered.
   * Defaults: qcStatus='pending', qtyAccepted=0 (set on post if 'passed').
   */
  async create(input: CreateGoodsReceiptInput) {
    if (input.lines.length === 0) throw new Error('GRN must have at least one line');

    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1);
      if (!po) throw new Error(`PO ${input.purchaseOrderId} not found`);
      if (!['confirmed', 'partial_received'].includes(po.status)) {
        throw new Error(
          `PO ${po.poNumber} is ${po.status}, must be confirmed or partial_received to receive`,
        );
      }

      const poLines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
      const poLinesMap = new Map(poLines.map((l) => [l.id, l]));

      // Per-line quantity check: existing already-received + this GRN ≤ ordered
      for (const line of input.lines) {
        const poLine = poLinesMap.get(line.purchaseOrderLineId);
        if (!poLine) {
          throw new Error(`PO line ${line.purchaseOrderLineId} not found on PO ${po.poNumber}`);
        }
        const ordered = Number(poLine.qtyOrdered);
        const alreadyRecv = Number(poLine.qtyReceived);
        const remaining = ordered - alreadyRecv;
        if (line.qtyReceived > remaining + 1e-9) {
          throw new GrnQuantityExceedsPoError(poLine.id, line.qtyReceived, remaining);
        }
      }

      const allocated = await this.seq.allocate(
        'GRN',
        new Date(input.receivedDate ?? Date.now()),
      );
      const grnId = uuidv7();

      await tx.insert(goodsReceipts).values({
        id: grnId,
        grnNumber: allocated.number,
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        receivedDate: input.receivedDate ?? new Date().toISOString().slice(0, 10),
        destinationWarehouseId: po.destinationWarehouseId,
        supplierDeliveryNote: input.supplierDeliveryNote ?? null,
        status: 'draft',
        receivedBy: input.receivedBy ?? null,
        notes: input.notes ?? null,
      });

      await tx.insert(goodsReceiptLines).values(
        input.lines.map((l) => {
          const poLine = poLinesMap.get(l.purchaseOrderLineId)!;
          const qcStatus: QcStatus = l.qcStatus ?? 'pending';
          const accepted =
            qcStatus === 'passed' ? l.qtyAccepted ?? l.qtyReceived : l.qtyAccepted ?? 0;
          return {
            id: uuidv7(),
            goodsReceiptId: grnId,
            purchaseOrderLineId: l.purchaseOrderLineId,
            productId: poLine.productId,
            qtyReceived: String(l.qtyReceived),
            qtyAccepted: String(accepted),
            qtyRejected: String(l.qtyRejected ?? 0),
            qcStatus,
            qcNotes: l.qcNotes ?? null,
            unitCostCents: l.unitCostCents ?? poLine.unitPriceCents,
            lotCode: l.lotCode ?? null,
            serialNo: l.serialNo ?? null,
            expiryDate: l.expiryDate ?? null,
          };
        }),
      );

      this.logger.log(`GRN ${allocated.number} draft for PO ${po.poNumber} (${input.lines.length} lines)`);
      return await this.findByIdInTx(tx, grnId);
    });
  }

  /**
   * Update QC status on a draft GRN line. Required before posting if any line
   * is still pending — receivers can't post a draft with un-graded lines.
   */
  async setLineQc(input: {
    grnLineId: string;
    qcStatus: QcStatus;
    qtyAccepted?: number;
    qtyRejected?: number;
    qcNotes?: string;
  }) {
    const [line] = await this.db
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.id, input.grnLineId))
      .limit(1);
    if (!line) throw new Error(`GRN line ${input.grnLineId} not found`);

    const qtyReceived = Number(line.qtyReceived);
    const accepted = input.qtyAccepted ?? (input.qcStatus === 'passed' ? qtyReceived : 0);
    const rejected = input.qtyRejected ?? (input.qcStatus === 'failed' ? qtyReceived : 0);

    await this.db
      .update(goodsReceiptLines)
      .set({
        qcStatus: input.qcStatus,
        qtyAccepted: String(accepted),
        qtyRejected: String(rejected),
        qcNotes: input.qcNotes ?? line.qcNotes,
      })
      .where(eq(goodsReceiptLines.id, input.grnLineId));
    this.logger.log(`GRN line ${input.grnLineId} → qc=${input.qcStatus} accepted=${accepted}`);
  }

  /**
   * Post a draft GRN: marks status='posted', updates PO line qtyReceived,
   * publishes GoodsReceivedEvent (consumed by inventory handler to call
   * StockService.receiveStock per QC-passed line). Failed/quarantine lines do
   * NOT bump stock.
   */
  async post(grnId: string, postedBy?: string) {
    const grn = await this.findById(grnId);
    if (!grn) throw new Error(`GRN ${grnId} not found`);
    if (grn.status !== 'draft') {
      throw new GoodsReceiptStateError(grnId, grn.status, 'posted');
    }

    // Reject if any line is still pending (forces QC decisions before posting).
    const pendingLines = grn.lines.filter((l) => l.qcStatus === 'pending');
    if (pendingLines.length > 0) {
      throw new Error(
        `GRN ${grn.grnNumber} has ${pendingLines.length} pending QC lines — set QC status before posting`,
      );
    }

    return this.db.transaction(async (tx) => {
      // Update PO lines: bump qtyReceived for each non-failed line.
      for (const line of grn.lines) {
        if (line.qcStatus === 'failed') continue; // failed lines don't count toward PO fulfilment
        const qtyToCredit =
          line.qcStatus === 'passed' ? Number(line.qtyAccepted) : Number(line.qtyReceived); // quarantine still counts as PO-fulfilled (pending disposition)
        if (qtyToCredit <= 0) continue;
        await tx
          .update(purchaseOrderLines)
          .set({
            qtyReceived: sql`${purchaseOrderLines.qtyReceived}::numeric + ${qtyToCredit}`,
          })
          .where(eq(purchaseOrderLines.id, line.purchaseOrderLineId));
      }

      await tx
        .update(goodsReceipts)
        .set({
          status: 'posted',
          postedAt: new Date(),
          postedBy: postedBy ?? null,
          updatedAt: new Date(),
        })
        .where(eq(goodsReceipts.id, grnId));

      this.logger.log(
        `GRN ${grn.grnNumber} posted by ${postedBy ?? '(unknown)'} — ${grn.lines.length} lines`,
      );

      return { grnId, grnNumber: grn.grnNumber, lines: grn.lines };
    }).then(async (result) => {
      // After PO update commits, recompute PO status (partial_received / received).
      await this.purchaseOrders.recomputeReceiptStatus(grn.purchaseOrderId);

      // Publish event for inventory handler.
      this.eventBus.publish(
        new GoodsReceivedEvent(
          result.grnId,
          result.grnNumber,
          grn.purchaseOrderId,
          grn.supplierId,
          grn.destinationWarehouseId,
          result.lines.map((l) => ({
            grnLineId: l.id,
            poLineId: l.purchaseOrderLineId,
            productId: l.productId,
            qtyAccepted: Number(l.qtyAccepted),
            unitCostCents: l.unitCostCents,
            qcStatus: l.qcStatus as 'pending' | 'passed' | 'failed' | 'quarantine',
            lotCode: l.lotCode,
            serialNo: l.serialNo,
            expiryDate: l.expiryDate,
          })),
          new Date(),
        ),
      );

      return result;
    });
  }

  async cancel(grnId: string, reason: string) {
    const [grn] = await this.db
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.id, grnId))
      .limit(1);
    if (!grn) throw new Error(`GRN ${grnId} not found`);
    if (grn.status !== 'draft') {
      throw new GoodsReceiptStateError(grnId, grn.status, 'cancelled');
    }
    await this.db
      .update(goodsReceipts)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(goodsReceipts.id, grnId));
    this.logger.log(`GRN ${grn.grnNumber} cancelled: ${reason}`);
  }

  async findById(grnId: string) {
    const [grn] = await this.db
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.id, grnId))
      .limit(1);
    if (!grn) return null;
    const lines = await this.db
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grnId))
      .orderBy(asc(goodsReceiptLines.id));
    return { ...grn, lines };
  }

  private async findByIdInTx(tx: any, grnId: string) {
    const [grn] = await tx
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.id, grnId))
      .limit(1);
    if (!grn) return null;
    const lines = await tx
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grnId))
      .orderBy(asc(goodsReceiptLines.id));
    return { ...grn, lines };
  }

  async listForPo(poId: string) {
    return this.db
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.purchaseOrderId, poId))
      .orderBy(asc(goodsReceipts.receivedDate));
  }
}
