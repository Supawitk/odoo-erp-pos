import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';
import { eq, inArray } from 'drizzle-orm';
import {
  isValidTIN,
  normalizeTIN,
  generatePromptPayBill,
  computeExcise,
  type ExciseCategory,
} from '@erp/shared';
import { posOrders, posSessions, products, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { EncryptionService } from '../../../../shared/infrastructure/crypto/encryption.service';
import { OrganizationService } from '../../../organization/organization.service';
import { CreateOrderCommand } from './create-order.command';
import { Order } from '../../domain/order.entity';
import { decideDocumentType } from '../../domain/document';
import { priceOrder } from '../../domain/pricing';
import { OrderCompletedEvent } from '../../domain/events';
import { InvalidBuyerTinError } from '../../domain/errors';
import { DocumentSequenceService } from '../../infrastructure/document-sequence.service';

@Injectable()
@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler implements ICommandHandler<CreateOrderCommand> {
  private readonly logger = new Logger(CreateOrderHandler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly eventBus: EventBus,
    private readonly sequences: DocumentSequenceService,
    private readonly crypto: EncryptionService,
  ) {}

  async execute(cmd: CreateOrderCommand) {
    const existing = await this.findByOfflineId(cmd.offlineId);
    if (existing) {
      this.logger.log(`Idempotent replay: offlineId=${cmd.offlineId}`);
      return this.toResponse(existing);
    }

    const settings = await this.org.snapshot();
    const thaiMode = settings.countryMode === 'TH';

    // 1. Validate buyer TIN up-front (Thai mode only; in GENERIC, buyer block
    //    is captured as plain metadata without mod-11 checksum enforcement).
    let buyer = cmd.buyer;
    if (thaiMode && buyer?.tin) {
      const normalised = normalizeTIN(buyer.tin);
      if (!isValidTIN(normalised)) {
        throw new InvalidBuyerTinError(buyer.tin);
      }
      buyer = {
        ...buyer,
        tin: normalised,
        branch: buyer.branch ? buyer.branch.padStart(5, '0') : '00000',
      };
    } else if (!thaiMode && buyer) {
      // Strip Thai-only fields in GENERIC mode.
      buyer = { name: buyer.name, address: buyer.address };
    }

    // 2. 🇹🇭 Hydrate per-line excise from product master (Thai mode only).
    //    Excise is computed BEFORE VAT and folded into the VAT base by priceOrder.
    let hydratedLines = cmd.lines;
    if (thaiMode) {
      hydratedLines = await this.hydrateExciseAndVatCategory(cmd.lines);
    }

    // 3. Price the order server-side. VAT rate in GENERIC is configurable but
    //    `vatRegistered=false` zeroes it via the pricing engine.
    const effectiveVatRate = settings.vatRegistered ? settings.vatRate : 0;
    const priced = priceOrder({
      lines: hydratedLines,
      cartDiscountCents: cmd.cartDiscountCents,
      vatMode: cmd.vatMode ?? settings.defaultVatMode,
      vatRate: effectiveVatRate,
    });

    // 4. Decide document type + allocate a number. In GENERIC mode the decider
    //    always returns RE so ABB/TX routing short-circuits cleanly.
    const decision = thaiMode
      ? decideDocumentType({
          vatRegistered: settings.vatRegistered,
          buyer,
          totalCents: priced.totalCents,
          abbreviatedCapCents: settings.abbreviatedTaxInvoiceCapCents,
        })
      : { type: 'RE' as const, suggestAskTIN: false, reason: 'non-Thai mode' };
    // Resolve branch_code from the session (defaults to '00000' = HQ).
    // Multi-branch merchants open sessions per branch; the allocator
    // partitions sequences by (type, period, branchCode) so each branch
    // gets its own {BR}-TX-YYMM-##### series as required by §86/4.
    let sessionBranchCode = '00000';
    if (cmd.sessionId) {
      const [sess] = await this.db
        .select({ branchCode: posSessions.branchCode })
        .from(posSessions)
        .where(eq(posSessions.id, cmd.sessionId))
        .limit(1);
      sessionBranchCode = sess?.branchCode ?? '00000';
    }
    const allocated = await this.sequences.allocate(decision.type, new Date(), sessionBranchCode);

    // 5. Generate PromptPay Ref1 (used for QR + webhook correlation). Only
    //    stored when Thai mode is active — otherwise it's dead bytes.
    const id = uuidv7();
    const promptpayRef = thaiMode
      ? id.replace(/-/g, '').slice(0, 20).toUpperCase()
      : null;

    // 5. Build aggregate. Currency falls back to the org default when the
    //    client didn't pin one.
    const order = Order.create({
      id,
      offlineId: cmd.offlineId,
      sessionId: cmd.sessionId,
      customerId: cmd.customerId,
      buyer,
      lines: priced.lines,
      subtotalCents: priced.subtotalCents,
      discountCents: priced.discountCents,
      taxCents: priced.taxCents,
      totalCents: priced.totalCents,
      vatBreakdown: priced.vatBreakdown,
      currency: cmd.currency ?? settings.currency,
      payment: cmd.payment,
      status: 'paid',
      documentType: decision.type,
      documentNumber: allocated.number,
      promptpayRef: promptpayRef ?? undefined,
      iPadDeviceId: cmd.iPadDeviceId,
      createdAt: new Date(),
    });

    // 6. Persist. PII fields (TIN + address) are dual-written: plaintext kept
    // for transitional reads, ciphertext + sha256 hash written alongside per
    // EncryptionService. Decrypt-on-read happens in the renderer + reports.
    const buyerTinEnc = await this.crypto.encryptAndHash(order.buyer?.tin ?? null);
    const buyerAddressCipher = await this.crypto.encrypt(order.buyer?.address ?? null);

    let row: typeof posOrders.$inferSelect;
    try {
      [row] = await this.db
        .insert(posOrders)
        .values({
          id: order.id,
          sessionId: order.sessionId,
          customerId: order.customerId ?? null,
          orderLines: order.lines,
          subtotalCents: order.subtotalCents,
          taxCents: order.taxCents,
          discountCents: order.discountCents,
          totalCents: order.totalCents,
          currency: order.currency,
          paymentMethod: order.payment.method,
          paymentDetails: {
            amountCents: order.payment.amountCents,
            tenderedCents: order.payment.tenderedCents,
            changeCents: order.payment.changeCents,
            cardLast4: order.payment.cardLast4,
            promptpaySlipSsid: order.payment.promptpaySlipSsid,
          },
          status: order.status,
          iPadDeviceId: order.iPadDeviceId ?? null,
          offlineId: order.offlineId,
          documentType: order.documentType,
          documentNumber: order.documentNumber ?? null,
          buyerName: order.buyer?.name ?? null,
          buyerTin: order.buyer?.tin ?? null,
          buyerTinEncrypted: buyerTinEnc.encrypted,
          buyerTinHash: buyerTinEnc.hash,
          buyerBranch: order.buyer?.branch ?? null,
          buyerAddress: order.buyer?.address ?? null,
          buyerAddressEncrypted: buyerAddressCipher,
          vatBreakdown: order.vatBreakdown,
          promptpayRef: order.promptpayRef ?? null,
        })
        .returning();
    } catch (err: any) {
      if (err?.code === '23505') {
        const raced = await this.findByOfflineId(cmd.offlineId);
        if (raced) {
          this.logger.warn(`Idempotent race: offlineId=${cmd.offlineId} winner returned`);
          return this.toResponse(raced);
        }
      }
      throw err;
    }

    // 7. Publish event.
    this.eventBus.publish(
      new OrderCompletedEvent(
        order.id,
        order.sessionId,
        order.totalCents,
        order.currency,
        order.createdAt,
      ),
    );

    this.logger.log(
      `Order ${order.documentNumber} [${order.documentType}] total=${order.totalCents} vat=${order.taxCents} ${order.currency}`,
    );

    return {
      ...this.toResponse(row),
      documentDecision: decision,
      promptpayQr:
        thaiMode && promptpayRef
          ? this.buildPromptPayQrIfApplicable(
              order,
              priced.totalCents,
              promptpayRef,
              settings.promptpayBillerId,
            )
          : null,
    };
  }

  private buildPromptPayQrIfApplicable(
    order: Order,
    totalCents: number,
    ref: string,
    billerId: string | null,
  ): string | null {
    if (order.payment.method !== 'promptpay') return null;
    if (!billerId) return null;
    return generatePromptPayBill({
      billerId,
      amountBaht: totalCents / 100,
      ref1: ref,
    });
  }

  private async findByOfflineId(offlineId: string) {
    const rows = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.offlineId, offlineId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Look up product attributes (vatCategory + excise) for each line and stitch
   * them onto the line objects so the pricing engine sees the right VAT
   * category and the correct pre-VAT excise amount. Looking up products in one
   * `inArray` query keeps this O(1) round-trips per checkout.
   */
  private async hydrateExciseAndVatCategory(
    lines: CreateOrderCommand['lines'],
  ): Promise<CreateOrderCommand['lines']> {
    const ids = Array.from(new Set(lines.map((l) => l.productId)));
    if (ids.length === 0) return lines;
    const rows = await this.db
      .select({
        id: products.id,
        vatCategory: products.vatCategory,
        exciseCategory: products.exciseCategory,
        exciseSpecificCentsPerUnit: products.exciseSpecificCentsPerUnit,
        exciseAdValoremBp: products.exciseAdValoremBp,
        sugarGPer100ml: products.sugarGPer100ml,
        volumeMl: products.volumeMl,
        abvBp: products.abvBp,
      })
      .from(products)
      .where(inArray(products.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));

    return lines.map((line) => {
      const p = byId.get(line.productId);
      if (!p) return line; // unknown product — pricing engine will use line-level defaults

      // VAT category from product master, unless caller already overrode.
      const vatCategoryFromProduct = mapVatCategory(p.vatCategory);
      const vatCategory = line.vatCategory ?? vatCategoryFromProduct;

      // Excise: zero out unless category present.
      let exciseCents = 0;
      if (p.exciseCategory) {
        const r = computeExcise({
          product: {
            category: p.exciseCategory as ExciseCategory,
            exciseSpecificCentsPerUnit: p.exciseSpecificCentsPerUnit,
            exciseAdValoremBp: p.exciseAdValoremBp,
            sugarGPer100ml: p.sugarGPer100ml,
            volumeMl: p.volumeMl,
            abvBp: p.abvBp,
          },
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
        });
        exciseCents = r.exciseCents;
      }

      return { ...line, vatCategory, exciseCents };
    });
  }

  private toResponse(row: typeof posOrders.$inferSelect) {
    return {
      id: row.id,
      sessionId: row.sessionId,
      customerId: row.customerId,
      orderLines: row.orderLines,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      discountCents: row.discountCents,
      totalCents: row.totalCents,
      currency: row.currency,
      paymentMethod: row.paymentMethod,
      status: row.status,
      offlineId: row.offlineId,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      buyer: row.buyerName
        ? {
            name: row.buyerName,
            tin: row.buyerTin,
            branch: row.buyerBranch,
            address: row.buyerAddress,
          }
        : null,
      vatBreakdown: row.vatBreakdown,
      promptpayRef: row.promptpayRef,
      createdAt: row.createdAt,
    };
  }
}

/** Map DB string `vat_category` to the @erp/shared union type. */
function mapVatCategory(raw: string | null): 'standard' | 'zero_rated' | 'exempt' {
  switch (raw) {
    case 'zero':
    case 'zero_rated':
      return 'zero_rated';
    case 'exempt':
      return 'exempt';
    default:
      return 'standard';
  }
}
