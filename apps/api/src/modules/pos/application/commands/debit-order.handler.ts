import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { computeThaiVat } from '@erp/shared';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrganizationService } from '../../../organization/organization.service';
import { DebitOrderCommand } from './debit-order.command';
import { OrderNotFoundError } from '../../domain/errors';
import { OrderCompletedEvent } from '../../domain/events';
import { DocumentSequenceService } from '../../infrastructure/document-sequence.service';

/**
 * Debit note (§86/9 — ใบเพิ่มหนี้).
 *
 * Inputs: original order id + additional charge lines + reason.
 * Output: a new posOrders row with documentType='DN', positive totals,
 *         originalOrderId pointing at the source. The original invoice
 *         stays `paid` — DN is additive, NOT a state change of the original.
 *
 * Differences from the CN flow:
 *   - DN amounts are POSITIVE (charges added), not negative
 *   - Original must be paid AND a TX/ABB/RE — DN cannot reference a CN or DN
 *   - DN does NOT mutate the original's status
 *   - DN appears as a positive line on the seller's PP.30 (output VAT goes UP)
 *     and as a positive line on the buyer's PP.30 input VAT
 */
@Injectable()
@CommandHandler(DebitOrderCommand)
export class DebitOrderHandler implements ICommandHandler<DebitOrderCommand> {
  private readonly logger = new Logger(DebitOrderHandler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly eventBus: EventBus,
    private readonly sequences: DocumentSequenceService,
  ) {}

  async execute(cmd: DebitOrderCommand) {
    if (!cmd.additionalLines?.length) {
      throw new BadRequestException('DN must have at least one additional line');
    }
    if (!cmd.reason || cmd.reason.trim().length < 3) {
      throw new BadRequestException('DN reason required (≥3 chars) — §86/9 audit evidence');
    }
    for (const l of cmd.additionalLines) {
      if (!l.description?.trim()) throw new BadRequestException('DN line description required');
      if (!Number.isFinite(l.qty) || l.qty <= 0) {
        throw new BadRequestException(`DN line qty must be > 0 (got ${l.qty})`);
      }
      if (!Number.isInteger(l.unitPriceCents) || l.unitPriceCents <= 0) {
        throw new BadRequestException(
          `DN line unitPriceCents must be a positive integer (got ${l.unitPriceCents})`,
        );
      }
    }

    const [original] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, cmd.originalOrderId))
      .limit(1);
    if (!original) throw new OrderNotFoundError(cmd.originalOrderId);
    if (original.status !== 'paid') {
      throw new BadRequestException(
        `Original order is ${original.status}; only paid orders can carry a DN`,
      );
    }
    if (original.documentType === 'CN' || original.documentType === 'DN') {
      throw new BadRequestException(
        `Original is ${original.documentType}; DN can only reference RE/ABB/TX`,
      );
    }

    const settings = await this.org.snapshot();

    const vat = computeThaiVat(
      cmd.additionalLines.map((l, i) => ({
        id: String(i),
        amountCents: l.qty * l.unitPriceCents,
        category: l.vatCategory ?? 'standard',
      })),
      {
        defaultMode: settings.defaultVatMode,
        rate: settings.vatRegistered ? settings.vatRate : 0,
      },
    );

    const allocated = await this.sequences.allocate('DN');
    const id = uuidv7();
    // The receipt renderer expects each line to have a `name` field (POS
    // convention). DN inputs use `description`; mirror it into name so the
    // existing Thai/generic templates render without special-casing.
    const enrichedLines = cmd.additionalLines.map((l, i) => ({
      ...l,
      name: l.description,
      netCents: vat.perLine[i].netCents,
      vatCents: vat.perLine[i].vatCents,
      grossCents: vat.perLine[i].grossCents,
    }));

    const [dnRow] = await this.db
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
        paymentDetails: { dnReason: cmd.reason, approvedBy: cmd.approvedBy },
        status: 'paid', // DN is itself a settled additive charge — caller arranges actual collection separately
        offlineId: `dn-${id}`,
        documentType: 'DN',
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

    // Original status untouched — DN is additive.

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
      `DN issued: ${allocated.number} for order ${cmd.originalOrderId} amount=+${vat.grossCents} (${cmd.reason})`,
    );

    return {
      id: dnRow.id,
      documentNumber: dnRow.documentNumber,
      documentType: dnRow.documentType,
      totalCents: dnRow.totalCents,
      taxCents: dnRow.taxCents,
      vatBreakdown: dnRow.vatBreakdown,
      originalOrderId: dnRow.originalOrderId,
      reason: cmd.reason,
      createdAt: dnRow.createdAt,
    };
  }
}
