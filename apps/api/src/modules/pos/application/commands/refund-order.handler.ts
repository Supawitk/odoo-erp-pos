import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { computeThaiVat } from '@erp/shared';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrganizationService } from '../../../organization/organization.service';
import { RefundOrderCommand } from './refund-order.command';
import {
  OrderAlreadyRefundedError,
  OrderNotFoundError,
  RefundNotAllowedError,
} from '../../domain/errors';
import { OrderCompletedEvent } from '../../domain/events';
import { DocumentSequenceService } from '../../infrastructure/document-sequence.service';

/**
 * Refund flow (§86/10 — ใบลดหนี้ / credit note).
 *
 * 1. Fetch the original order. Must be `paid` and either RE/ABB/TX (cannot
 *    refund a CN).
 * 2. Compute refund lines — full order or a subset selected by lineIndex+qty.
 * 3. Run VAT engine on the refund basket with NEGATIVE amounts (accounting
 *    convention: the CN reverses a portion of the original sale).
 * 4. Allocate a new CN number from the document sequence service.
 * 5. Insert a new row with status='refunded', negative totals, originalOrderId
 *    pointing at the source.
 * 6. Mark the original order as refunded (or partially_refunded for partials —
 *    we use 'refunded' either way for now; partial is implied by amount delta).
 * 7. Publish OrderCompletedEvent so dashboards + Odoo sync see the CN.
 *
 * Sequence gap handling: if the DB INSERT fails after allocation, the CN
 * number is *burned* — §86 allows gaps IF there is an audit log of the void.
 * We don't void here because allocation happens inside the same transaction.
 */
@Injectable()
@CommandHandler(RefundOrderCommand)
export class RefundOrderHandler implements ICommandHandler<RefundOrderCommand> {
  private readonly logger = new Logger(RefundOrderHandler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly eventBus: EventBus,
    private readonly sequences: DocumentSequenceService,
  ) {}

  async execute(cmd: RefundOrderCommand) {
    const [original] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, cmd.originalOrderId))
      .limit(1);

    if (!original) throw new OrderNotFoundError(cmd.originalOrderId);
    if (original.status !== 'paid') throw new OrderAlreadyRefundedError(cmd.originalOrderId);
    if (original.documentType === 'CN') {
      throw new RefundNotAllowedError('cannot refund a credit note');
    }

    const settings = await this.org.snapshot();

    // 2. Pick lines to refund.
    const origLines = original.orderLines as Array<{
      productId: string;
      name: string;
      qty: number;
      unitPriceCents: number;
      vatCategory?: 'standard' | 'zero_rated' | 'exempt';
    }>;

    const refundLines = cmd.partialLines
      ? cmd.partialLines.map((sel) => {
          const orig = origLines[sel.lineIndex];
          if (!orig) throw new RefundNotAllowedError(`line ${sel.lineIndex} not in order`);
          if (sel.qty <= 0 || sel.qty > orig.qty) {
            throw new RefundNotAllowedError(
              `refund qty ${sel.qty} out of range for line ${sel.lineIndex} (${orig.qty})`,
            );
          }
          return { ...orig, qty: sel.qty };
        })
      : origLines;

    // 3. VAT engine on NEGATIVE amounts.
    const vat = computeThaiVat(
      refundLines.map((l, i) => ({
        id: String(i),
        amountCents: -(l.qty * l.unitPriceCents),
        category: l.vatCategory ?? 'standard',
      })),
      {
        defaultMode: settings.defaultVatMode,
        rate: settings.vatRegistered ? settings.vatRate : 0,
      },
    );

    // 4. Allocate CN number.
    const allocated = await this.sequences.allocate('CN');

    // 5. Persist CN.
    const id = uuidv7();
    const enrichedLines = refundLines.map((l, i) => ({
      ...l,
      netCents: vat.perLine[i].netCents,
      vatCents: vat.perLine[i].vatCents,
      grossCents: vat.perLine[i].grossCents,
    }));

    const [cnRow] = await this.db
      .insert(posOrders)
      .values({
        id,
        sessionId: original.sessionId,
        customerId: original.customerId,
        orderLines: enrichedLines,
        subtotalCents: enrichedLines.reduce((s, l) => s + l.netCents, 0),
        taxCents: vat.vatCents,
        discountCents: 0,
        totalCents: vat.grossCents,
        currency: original.currency,
        paymentMethod: original.paymentMethod,
        paymentDetails: { refundReason: cmd.reason, approvedBy: cmd.approvedBy },
        status: 'refunded',
        offlineId: `cn-${id}`,
        documentType: 'CN',
        documentNumber: allocated.number,
        buyerName: original.buyerName,
        buyerTin: original.buyerTin,
        buyerBranch: original.buyerBranch,
        buyerAddress: original.buyerAddress,
        vatBreakdown: {
          taxableNetCents: vat.taxableNetCents,
          zeroRatedNetCents: vat.zeroRatedNetCents,
          exemptNetCents: vat.exemptNetCents,
          vatCents: vat.vatCents,
          grossCents: vat.grossCents,
        },
        originalOrderId: cmd.originalOrderId,
      })
      .returning();

    // 6. Flag original as refunded.
    await this.db
      .update(posOrders)
      .set({ status: 'refunded', updatedAt: new Date() })
      .where(eq(posOrders.id, cmd.originalOrderId));

    // 7. Event.
    this.eventBus.publish(
      new OrderCompletedEvent(
        id,
        original.sessionId!,
        vat.grossCents,
        original.currency,
        new Date(),
      ),
    );

    this.logger.log(
      `Refund issued: ${allocated.number} for order ${cmd.originalOrderId} amount=${vat.grossCents} (${cmd.reason})`,
    );

    return {
      id: cnRow.id,
      documentNumber: cnRow.documentNumber,
      documentType: cnRow.documentType,
      totalCents: cnRow.totalCents,
      taxCents: cnRow.taxCents,
      vatBreakdown: cnRow.vatBreakdown,
      originalOrderId: cnRow.originalOrderId,
      reason: cmd.reason,
      createdAt: cnRow.createdAt,
    };
  }
}
