import { Inject, Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  computeThaiVat,
  type ThaiVatCategory,
  type ThaiVatMode,
} from '@erp/shared';
import {
  billPayments,
  chartOfAccounts,
  goodsReceiptLines,
  partners,
  purchaseOrderLines,
  vendorBillLines,
  vendorBills,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { PurchasingSequenceService } from '../infrastructure/purchasing-sequence.service';
import { JournalRepository } from '../../accounting/infrastructure/journal.repository';
import { OrganizationService } from '../../organization/organization.service';
import { JournalEntry, type JournalLine } from '../../accounting/domain/journal-entry';
import {
  classifyLineMatch,
  rollupBillMatch,
  type LineMatchResult,
} from '../domain/three-way-match';
import {
  computeWhtCents,
  whtRateBp,
  type WhtCategory,
} from '../domain/wht';
import {
  allocatePaymentSplit,
  PaymentAllocationError,
} from '../domain/payment-allocation';

export type VendorBillStatus = 'draft' | 'posted' | 'partially_paid' | 'paid' | 'void';

export interface CreateVendorBillLineInput {
  productId?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  vatCategory?: ThaiVatCategory;
  vatMode?: ThaiVatMode;
  whtCategory?: WhtCategory | null;
  /**
   * Optional override for the WHT rate (basis points). Honoured only when
   * `whtCategory` is set. Use for DTA reductions on foreign payments or
   * special-rate contracts. Must be 0–10000.
   */
  whtRateBpOverride?: number | null;
  /** Override 5100 (product) or 6200 (service) default by passing a CoA code. */
  expenseAccountCode?: string;
  /** 3-way-match references. */
  purchaseOrderLineId?: string | null;
  goodsReceiptLineId?: string | null;
}

export interface CreateVendorBillInput {
  supplierId: string;
  purchaseOrderId?: string | null;
  billDate: string;
  dueDate?: string | null;
  supplierInvoiceNumber?: string | null;
  supplierTaxInvoiceNumber?: string | null;
  supplierTaxInvoiceDate?: string | null;
  currency?: string;
  vatMode?: ThaiVatMode;
  notes?: string;
  lines: CreateVendorBillLineInput[];
}

export interface PayVendorBillInput {
  /** ISO date — defaults to today. */
  paidDate?: string;
  /** 1110 cash / 1120 bank — caller picks the channel. */
  cashAccountCode?: string;
  paidBy?: string;
}

export interface RecordPaymentInput {
  /** Gross amount applied to AP for this installment. Must be > 0 and ≤ remaining. */
  amountCents: number;
  /** Bank wire / merchant fee deducted from settlement (we absorb to 6170). */
  bankChargeCents?: number;
  /** ISO date — defaults to today. */
  paymentDate?: string;
  /** 1110 cash / 1120 bank — caller picks the channel. */
  cashAccountCode?: string;
  /** bank_transfer | cheque | cash | promptpay | card. */
  paymentMethod?: string;
  /** Wire ref / cheque #. Audit aid; not enforced. */
  bankReference?: string;
  paidBy?: string;
  notes?: string;
}

@Injectable()
export class VendorBillsService {
  private readonly logger = new Logger(VendorBillsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly seq: PurchasingSequenceService,
    private readonly journals: JournalRepository,
    private readonly org: OrganizationService,
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────
  async create(input: CreateVendorBillInput) {
    if (!input.lines?.length) {
      throw new BadRequestException('Bill must have at least one line');
    }
    const supplier = await this.requireSupplier(input.supplierId);

    // Compute VAT per line via the shared engine. Need stable line ids so
    // the breakdown maps back into our line rows.
    const lineSeeds = input.lines.map((l, i) => ({
      seedId: `seed-${i}`,
      input: l,
      net:
        Math.max(0, l.qty * l.unitPriceCents - (l.discountCents ?? 0)),
    }));
    const vatResult = computeThaiVat(
      lineSeeds.map((s) => ({
        id: s.seedId,
        amountCents: s.net,
        category: s.input.vatCategory ?? 'standard',
        mode: s.input.vatMode ?? input.vatMode ?? 'exclusive',
      })),
      { defaultMode: input.vatMode ?? 'exclusive' },
    );

    const allocation = await this.seq.allocate('VB');

    const subtotal = lineSeeds.reduce((s, l) => s + l.net, 0);
    const vatTotal = vatResult.vatCents;
    const resolvedWhtRateBp = (input: CreateVendorBillLineInput): number | null => {
      if (!input.whtCategory) return null;
      if (typeof input.whtRateBpOverride === 'number') {
        if (input.whtRateBpOverride < 0 || input.whtRateBpOverride > 10000) {
          throw new BadRequestException(
            `whtRateBpOverride must be 0..10000 (got ${input.whtRateBpOverride})`,
          );
        }
        return input.whtRateBpOverride;
      }
      return whtRateBp(input.whtCategory);
    };
    const lineWhtCents = (net: number, input: CreateVendorBillLineInput): number => {
      const bp = resolvedWhtRateBp(input);
      if (bp == null) return 0;
      return Math.round((net * bp) / 10_000);
    };
    let whtTotal = 0;
    for (const seed of lineSeeds) {
      whtTotal += lineWhtCents(seed.net, seed.input);
    }
    // Total amount payable to the supplier = gross. WHT does NOT change the
    // bill total — it changes the cash payout at payment time.
    const total = vatResult.grossCents;

    const [billRow] = await this.db
      .insert(vendorBills)
      .values({
        internalNumber: allocation.number,
        supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
        supplierTaxInvoiceNumber: input.supplierTaxInvoiceNumber ?? null,
        supplierTaxInvoiceDate: input.supplierTaxInvoiceDate ?? null,
        supplierId: input.supplierId,
        purchaseOrderId: input.purchaseOrderId ?? null,
        billDate: input.billDate,
        dueDate: input.dueDate ?? null,
        currency: input.currency ?? 'THB',
        subtotalCents: subtotal,
        vatCents: vatTotal,
        whtCents: whtTotal,
        totalCents: total,
        vatBreakdown: { lines: vatResult.perLine, vatCents: vatTotal } as any,
        notes: input.notes,
      })
      .returning();

    // Insert lines
    await this.db.insert(vendorBillLines).values(
      lineSeeds.map((seed, i) => {
        const lb = vatResult.perLine.find((p) => p.lineId === seed.seedId);
        const wht = lineWhtCents(seed.net, seed.input);
        return {
          vendorBillId: billRow.id,
          lineNo: i + 1,
          productId: seed.input.productId ?? null,
          description: seed.input.description,
          qty: String(seed.input.qty) as any,
          unitPriceCents: seed.input.unitPriceCents,
          discountCents: seed.input.discountCents ?? 0,
          netCents: seed.net,
          vatCategory: seed.input.vatCategory ?? 'standard',
          vatMode: seed.input.vatMode ?? input.vatMode ?? 'exclusive',
          vatCents: lb?.vatCents ?? 0,
          whtCategory: seed.input.whtCategory ?? null,
          whtRateBp: resolvedWhtRateBp(seed.input),
          whtCents: wht,
          expenseAccountCode: seed.input.expenseAccountCode ?? null,
          purchaseOrderLineId: seed.input.purchaseOrderLineId ?? null,
          goodsReceiptLineId: seed.input.goodsReceiptLineId ?? null,
        };
      }),
    );

    this.logger.log(
      `Bill ${allocation.number} draft for supplier=${supplier.name} (${input.lines.length} lines, total=${total} VAT=${vatTotal} WHT=${whtTotal})`,
    );
    return this.findById(billRow.id);
  }

  // ─── Three-way match ───────────────────────────────────────────────────
  async runMatch(billId: string) {
    const bill = await this.findById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);

    // Pull the PO/GRN unit prices and qty_accepted for every referenced line.
    const lineIds = bill.lines
      .map((l) => l.purchaseOrderLineId)
      .filter((x): x is string => !!x);
    const grnIds = bill.lines
      .map((l) => l.goodsReceiptLineId)
      .filter((x): x is string => !!x);

    const poRows = lineIds.length
      ? await this.db
          .select({
            id: purchaseOrderLines.id,
            unitPriceCents: purchaseOrderLines.unitPriceCents,
          })
          .from(purchaseOrderLines)
          .where(inArray(purchaseOrderLines.id, lineIds))
      : [];
    const grnRows = grnIds.length
      ? await this.db
          .select({
            id: goodsReceiptLines.id,
            qtyAccepted: goodsReceiptLines.qtyAccepted,
          })
          .from(goodsReceiptLines)
          .where(inArray(goodsReceiptLines.id, grnIds))
      : [];

    const poByLine = new Map(poRows.map((r) => [r.id, Number(r.unitPriceCents)]));
    const grnByLine = new Map(
      grnRows.map((r) => [r.id, Number(r.qtyAccepted as unknown as number)]),
    );

    const lineResults: Array<{ id: string; result: LineMatchResult }> = bill.lines.map(
      (l) => {
        const result = classifyLineMatch({
          qty: Number(l.qty as unknown as number),
          unitPriceCents: l.unitPriceCents,
          poUnitPriceCents: l.purchaseOrderLineId
            ? poByLine.get(l.purchaseOrderLineId) ?? null
            : null,
          grnQtyAccepted: l.goodsReceiptLineId
            ? grnByLine.get(l.goodsReceiptLineId) ?? null
            : null,
        });
        return { id: l.id, result };
      },
    );

    const billStatus = rollupBillMatch(lineResults.map((x) => x.result));
    return { billStatus, lineResults };
  }

  // ─── Post (creates GL entry) ───────────────────────────────────────────
  async post(
    billId: string,
    options: { postedBy?: string; overrideMatchBy?: string; overrideReason?: string } = {},
  ) {
    const bill = await this.findById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    if (bill.status !== 'draft') {
      throw new BadRequestException(`Bill is ${bill.status}; only draft can be posted`);
    }

    const match = await this.runMatch(billId);
    const finalMatchStatus =
      match.billStatus === 'matched'
        ? 'matched'
        : options.overrideMatchBy
        ? 'override'
        : 'unmatched';

    if (match.billStatus !== 'matched' && !options.overrideMatchBy) {
      throw new BadRequestException(
        '3-way match failed — qty or price variance. Provide overrideMatchBy + overrideReason to post.',
      );
    }

    // Build the journal entry. One Dr per line (expense account), one Dr for
    // total Input VAT, one Cr to AP. Each line picks its own expense code:
    //   product line  → 5100 COGS — products
    //   service line  → 6200 Other operating expenses
    //   override      → caller-supplied account code
    const lines: JournalLine[] = [];
    for (const l of bill.lines) {
      const account = l.expenseAccountCode
        ? l.expenseAccountCode
        : l.productId
        ? '5100'
        : '6200';
      lines.push({
        accountCode: account,
        accountName: l.expenseAccountCode ? `Expense ${l.expenseAccountCode}` : (l.productId ? 'COGS — products' : 'Other operating expenses'),
        debitCents: l.netCents,
        creditCents: 0,
        description: l.description,
      });
    }
    if (bill.vatCents > 0) {
      lines.push({
        accountCode: '1155',
        accountName: 'Input VAT',
        debitCents: bill.vatCents,
        creditCents: 0,
        description: `Input VAT for ${bill.internalNumber}`,
      });
    }
    lines.push({
      accountCode: '2110',
      accountName: 'AP — trade',
      debitCents: 0,
      creditCents: bill.totalCents,
      description: `Payable to supplier`,
      partnerId: bill.supplierId,
    });

    const entry = JournalEntry.create({
      date: bill.billDate,
      description: `Vendor bill ${bill.internalNumber}`,
      reference: bill.supplierTaxInvoiceNumber ?? bill.supplierInvoiceNumber ?? null,
      sourceModule: 'purchasing.bill',
      sourceId: bill.id,
      currency: bill.currency,
      lines,
    });
    // Only forward postedBy if it parses as UUID — the journal_entries.posted_by
    // column is UUID-typed. Service-level actors ('system', 'cron') get null.
    const posted = await this.journals.insert(entry, {
      autoPost: true,
      postedBy: isUuid(options.postedBy) ? (options.postedBy as string) : null,
    });

    // Persist match status + state transition
    await this.db
      .update(vendorBills)
      .set({
        status: 'posted',
        matchStatus: finalMatchStatus,
        matchOverrideBy: options.overrideMatchBy ?? null,
        matchOverrideReason: options.overrideReason ?? null,
        journalEntryId: posted.id,
        postedAt: new Date(),
        postedBy: options.postedBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(vendorBills.id, billId));

    // Persist per-line match status for inspection
    for (const lr of match.lineResults) {
      await this.db
        .update(vendorBillLines)
        .set({
          matchStatus: lr.result.status,
          matchVarianceCents: lr.result.priceVarianceCents,
        })
        .where(eq(vendorBillLines.id, lr.id));
    }

    this.logger.log(
      `Bill ${bill.internalNumber} posted (${finalMatchStatus}) — journal #${posted.entryNumber}`,
    );
    return this.findById(billId);
  }

  // ─── Record one installment (creates payment GL entry) ────────────────
  /**
   * Adds one installment against a posted bill. Computes the proportional
   * WHT/cash split via `allocatePaymentSplit` and writes:
   *
   *   bill_payments    one row (next paymentNo, source-of-truth for the slice)
   *   journal_entries  Dr 2110 / Cr 1110|1120 [/ Cr 2203 if WHT]
   *   vendor_bills     paidCents/whtPaidCents updated; status flips to
   *                    partially_paid (mid) or paid (when balance reaches zero)
   *
   * Idempotency: caller must not retry blindly — we don't have an offlineId
   * field on bill_payments. The (vendor_bill_id, payment_no) UNIQUE keeps
   * concurrent racers honest, and the SELECT FOR UPDATE on the bill row
   * serialises installments per bill.
   */
  async recordPayment(billId: string, input: RecordPaymentInput) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new BadRequestException(
        `amountCents must be a positive integer (got ${input.amountCents})`,
      );
    }
    const cashAccount = input.cashAccountCode ?? '1120';
    const paymentDate =
      input.paymentDate ?? new Date().toISOString().slice(0, 10);

    // Resolve display name from CoA — works for any flagged cash account,
    // not just the seeded 1110/1120.
    const cashAcctRows = await this.db
      .select({
        name: chartOfAccounts.name,
        nameEn: chartOfAccounts.nameEn,
        isCashAccount: chartOfAccounts.isCashAccount,
        isActive: chartOfAccounts.isActive,
      })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.code, cashAccount))
      .limit(1);
    const cashAcct = cashAcctRows[0];
    if (!cashAcct || !cashAcct.isActive || !cashAcct.isCashAccount) {
      throw new BadRequestException(
        `cashAccountCode "${cashAccount}" is not a valid active cash account`,
      );
    }
    const cashAccountName = cashAcct.nameEn ?? cashAcct.name;

    return await this.db.transaction(async (tx) => {
      // Lock the bill row so concurrent installments don't double-allocate.
      const billRows = await tx
        .select()
        .from(vendorBills)
        .where(eq(vendorBills.id, billId))
        .limit(1)
        .for('update');
      const billRow = billRows[0];
      if (!billRow) throw new NotFoundException(`Bill ${billId} not found`);
      const status = billRow.status as VendorBillStatus;
      if (status !== 'posted' && status !== 'partially_paid') {
        throw new BadRequestException(
          `Bill is ${status}; only posted/partially_paid bills can receive payments`,
        );
      }

      const billTotal = Number(billRow.totalCents);
      const billWht = Number(billRow.whtCents);
      const paidSoFar = Number(billRow.paidCents ?? 0);
      const whtSoFar = Number(billRow.whtPaidCents ?? 0);

      let split;
      try {
        split = allocatePaymentSplit({
          amountCents: input.amountCents,
          bankChargeCents: input.bankChargeCents ?? 0,
          billTotalCents: billTotal,
          billWhtCents: billWht,
          paidCentsSoFar: paidSoFar,
          whtPaidCentsSoFar: whtSoFar,
        });
      } catch (e) {
        if (e instanceof PaymentAllocationError) {
          throw new BadRequestException(`${e.code}: ${e.message}`);
        }
        throw e;
      }

      // Allocate next payment_no (server-authoritative — never trusted from caller)
      const maxRow = await tx
        .select({ maxNo: sql<number>`coalesce(max(${billPayments.paymentNo}), 0)` })
        .from(billPayments)
        .where(eq(billPayments.vendorBillId, billId));
      const paymentNo = Number(maxRow[0]?.maxNo ?? 0) + 1;

      // Build + post the journal
      const lines: JournalLine[] = [
        {
          accountCode: '2110',
          accountName: 'AP — trade',
          debitCents: input.amountCents,
          creditCents: 0,
          description: `Settlement #${paymentNo} of ${billRow.internalNumber}`,
          partnerId: billRow.supplierId,
        },
        {
          accountCode: cashAccount,
          accountName: cashAccountName,
          debitCents: 0,
          creditCents: split.cashCents,
        },
      ];
      if (split.whtCents > 0) {
        lines.push({
          accountCode: '2203',
          accountName: 'WHT payable',
          debitCents: 0,
          creditCents: split.whtCents,
          description: `WHT withheld from ${billRow.internalNumber} (#${paymentNo})`,
        });
      }
      if (split.bankChargeCents > 0) {
        const settings = await this.org.snapshot();
        lines.push({
          accountCode: settings.defaultBankChargeAccount,
          accountName: 'Bank charge',
          debitCents: split.bankChargeCents,
          creditCents: 0,
          description: `Bank fee on ${billRow.internalNumber} #${paymentNo}`,
        });
      }
      const entry = JournalEntry.create({
        date: paymentDate,
        description: `Payment #${paymentNo} for ${billRow.internalNumber}`,
        reference: billRow.internalNumber,
        sourceModule: 'purchasing.bill-payment',
        sourceId: `${billRow.id}:${paymentNo}`, // composite — many payments per bill
        currency: billRow.currency,
        lines,
      });
      // Note: journals.insert opens its own transaction. That's safe — its
      // INSERTs are independent of the bill row lock we hold here. Should the
      // outer tx roll back after the journal commits, we'd be left with an
      // orphan journal — acceptable since the next reconcile run flags it,
      // and we don't depend on per-bill atomicity for accounting correctness.
      const posted = await this.journals.insert(entry, {
        autoPost: true,
        postedBy: isUuid(input.paidBy) ? (input.paidBy as string) : null,
      });

      // Insert installment row
      await tx.insert(billPayments).values({
        vendorBillId: billId,
        paymentNo,
        paymentDate,
        amountCents: input.amountCents,
        whtCents: split.whtCents,
        bankChargeCents: split.bankChargeCents,
        cashCents: split.cashCents,
        cashAccountCode: cashAccount,
        paymentMethod: input.paymentMethod ?? null,
        bankReference: input.bankReference ?? null,
        journalEntryId: posted.id,
        paidBy: input.paidBy ?? null,
        notes: input.notes ?? null,
      });

      // Update bill running totals + status
      const nextStatus: VendorBillStatus = split.isFinal ? 'paid' : 'partially_paid';
      await tx
        .update(vendorBills)
        .set({
          paidCents: split.newPaidCents,
          whtPaidCents: split.newWhtPaidCents,
          status: nextStatus,
          paymentJournalEntryId: posted.id,
          paidAt: split.isFinal ? new Date() : null,
          paidBy: split.isFinal ? input.paidBy ?? null : null,
          updatedAt: new Date(),
        })
        .where(eq(vendorBills.id, billId));

      this.logger.log(
        `Bill ${billRow.internalNumber} payment #${paymentNo} via ${cashAccount} amt=${input.amountCents} cash=${split.cashCents} WHT=${split.whtCents} → ${nextStatus}`,
      );
      return { paymentNo, journalEntryId: posted.id, allocation: split };
    });
  }

  /**
   * Backwards-compat: pre-partial-payments callers used `pay()` to settle the
   * full bill in one shot. Route them through `recordPayment` with amount
   * equal to the remaining balance.
   */
  async pay(billId: string, input: PayVendorBillInput = {}) {
    const bill = await this.findById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    if (bill.status !== 'posted' && bill.status !== 'partially_paid') {
      throw new BadRequestException(
        `Bill is ${bill.status}; only posted/partially_paid bills can be paid`,
      );
    }
    const remaining = bill.totalCents - bill.paidCents;
    if (remaining <= 0) {
      throw new BadRequestException(`Bill is already fully paid`);
    }
    await this.recordPayment(billId, {
      amountCents: remaining,
      paymentDate: input.paidDate,
      cashAccountCode: input.cashAccountCode,
      paidBy: input.paidBy,
    });
    return this.findById(billId);
  }

  // ─── List installments ────────────────────────────────────────────────
  async listPayments(billId: string) {
    const rows = await this.db
      .select()
      .from(billPayments)
      .where(eq(billPayments.vendorBillId, billId))
      .orderBy(billPayments.paymentNo);
    return rows.map((r) => ({
      id: r.id,
      paymentNo: r.paymentNo,
      paymentDate: r.paymentDate,
      amountCents: Number(r.amountCents),
      whtCents: Number(r.whtCents),
      bankChargeCents: Number(r.bankChargeCents ?? 0),
      cashCents: Number(r.cashCents),
      cashAccountCode: r.cashAccountCode,
      paymentMethod: r.paymentMethod,
      bankReference: r.bankReference,
      journalEntryId: r.journalEntryId,
      paidBy: r.paidBy,
      notes: r.notes,
      voidedAt: r.voidedAt,
      voidReason: r.voidReason,
      createdAt: r.createdAt,
    }));
  }

  // ─── Void one installment ──────────────────────────────────────────────
  /**
   * Void a single payment installment. Inserts a reversing journal entry
   * (Dr↔Cr swap of the original payment JE) via JournalRepository.void(),
   * marks the bill_payments row voided (audit trail), and rolls back the
   * bill's running totals.
   *
   * State transitions on the bill:
   *   paid           → partially_paid   (if other non-voided payments remain)
   *   paid           → posted           (if this was the only payment)
   *   partially_paid → partially_paid   (still has other payments)
   *   partially_paid → posted           (no other payments)
   *
   * Idempotent: voiding an already-voided row → 400 ALREADY_VOIDED.
   * Concurrency: SELECT FOR UPDATE on the bill row serialises with
   * recordPayment so a void can't race with a new payment.
   */
  async voidPayment(
    billId: string,
    paymentNo: number,
    reason: string,
    voidedBy?: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Void reason required (≥3 chars)');
    }

    // Lock the bill row first; journals.void runs in its own tx.
    const billRows = await this.db
      .select()
      .from(vendorBills)
      .where(eq(vendorBills.id, billId))
      .limit(1)
      .for('update');
    const billRow = billRows[0];
    if (!billRow) throw new NotFoundException(`Bill ${billId} not found`);

    const [pmt] = await this.db
      .select()
      .from(billPayments)
      .where(
        and(eq(billPayments.vendorBillId, billId), eq(billPayments.paymentNo, paymentNo)),
      )
      .limit(1);
    if (!pmt) {
      throw new NotFoundException(`Payment #${paymentNo} not found on bill ${billId}`);
    }
    if (pmt.voidedAt) {
      throw new BadRequestException(
        `Payment #${paymentNo} already voided at ${pmt.voidedAt.toISOString()}`,
      );
    }
    if (!pmt.journalEntryId) {
      throw new BadRequestException(
        `Payment #${paymentNo} has no journal entry to reverse`,
      );
    }

    // Reverse the JE first — it commits independently. Worst case if the
    // subsequent updates fail: we have a dangling reversal JE flagged by
    // the nightly reconcile. Same trade-off as recordPayment's insert path.
    await this.journals.void(
      pmt.journalEntryId,
      `Void payment #${paymentNo} of ${billRow.internalNumber}: ${reason}`,
      isUuid(voidedBy) ? (voidedBy as string) : null,
    );

    // Mark the row voided (audit), then recompute bill running totals from
    // surviving non-voided payments.
    await this.db
      .update(billPayments)
      .set({ voidedAt: new Date(), voidReason: reason })
      .where(eq(billPayments.id, pmt.id));

    const live = await this.db
      .select({
        paid: sql<number>`coalesce(sum(${billPayments.amountCents}), 0)::bigint`,
        wht: sql<number>`coalesce(sum(${billPayments.whtCents}), 0)::bigint`,
      })
      .from(billPayments)
      .where(
        and(eq(billPayments.vendorBillId, billId), isNull(billPayments.voidedAt)),
      );
    const newPaid = Number(live[0]?.paid ?? 0);
    const newWht = Number(live[0]?.wht ?? 0);

    // Latest non-voided payment's JE is the new "current" payment JE. Null
    // if every payment was voided (back to posted state).
    const [latest] = await this.db
      .select({ jeId: billPayments.journalEntryId })
      .from(billPayments)
      .where(
        and(eq(billPayments.vendorBillId, billId), isNull(billPayments.voidedAt)),
      )
      .orderBy(desc(billPayments.paymentNo))
      .limit(1);

    const billTotal = Number(billRow.totalCents);
    let nextStatus: VendorBillStatus;
    if (newPaid >= billTotal) nextStatus = 'paid';
    else if (newPaid > 0) nextStatus = 'partially_paid';
    else nextStatus = 'posted';

    await this.db
      .update(vendorBills)
      .set({
        paidCents: newPaid,
        whtPaidCents: newWht,
        status: nextStatus,
        paymentJournalEntryId: latest?.jeId ?? null,
        // Clear paidAt/paidBy if the bill is no longer fully paid.
        paidAt: nextStatus === 'paid' ? billRow.paidAt : null,
        paidBy: nextStatus === 'paid' ? billRow.paidBy : null,
        updatedAt: new Date(),
      })
      .where(eq(vendorBills.id, billId));

    this.logger.log(
      `Bill ${billRow.internalNumber} payment #${paymentNo} voided (reason="${reason}") → status=${nextStatus} paid=${newPaid} wht=${newWht}`,
    );
    return {
      paymentNo,
      voidedAt: new Date(),
      reason,
      newStatus: nextStatus,
      newPaidCents: newPaid,
      newWhtPaidCents: newWht,
    };
  }

  // ─── Void ──────────────────────────────────────────────────────────────
  async void(billId: string, reason: string, voidedBy?: string) {
    const bill = await this.findById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    if (bill.status === 'void') return bill;
    if (bill.status === 'paid') {
      throw new BadRequestException(
        'Cannot void a paid bill — reverse the payment first then void.',
      );
    }
    // If posted, void the journal too
    if (bill.status === 'posted' && bill.journalEntryId) {
      await this.journals.void(bill.journalEntryId, reason, voidedBy ?? null);
    }
    await this.db
      .update(vendorBills)
      .set({
        status: 'void',
        voidedAt: new Date(),
        voidReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(vendorBills.id, billId));
    return this.findById(billId);
  }

  // ─── Read ──────────────────────────────────────────────────────────────
  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(vendorBills)
      .where(eq(vendorBills.id, id))
      .limit(1);
    if (!rows[0]) return null;
    const lines = await this.db
      .select()
      .from(vendorBillLines)
      .where(eq(vendorBillLines.vendorBillId, id))
      .orderBy(vendorBillLines.lineNo);
    return mapBill(rows[0], lines);
  }

  async list(opts: { supplierId?: string; status?: VendorBillStatus; limit?: number } = {}) {
    const where = [] as any[];
    if (opts.supplierId) where.push(eq(vendorBills.supplierId, opts.supplierId));
    if (opts.status) where.push(eq(vendorBills.status, opts.status));
    const rows = await this.db
      .select()
      .from(vendorBills)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(vendorBills.billDate))
      .limit(Math.min(500, opts.limit ?? 100));
    return rows.map((r) => mapBillHeader(r));
  }

  private async requireSupplier(id: string) {
    const rows = await this.db
      .select({ id: partners.id, name: partners.name, isSupplier: partners.isSupplier })
      .from(partners)
      .where(eq(partners.id, id))
      .limit(1);
    if (!rows[0]) throw new BadRequestException(`Supplier ${id} not found`);
    if (!rows[0].isSupplier) {
      throw new BadRequestException(`Partner ${id} is not flagged as a supplier`);
    }
    return rows[0];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

function mapBillHeader(r: any) {
  return {
    id: r.id,
    internalNumber: r.internalNumber,
    supplierInvoiceNumber: r.supplierInvoiceNumber,
    supplierTaxInvoiceNumber: r.supplierTaxInvoiceNumber,
    supplierTaxInvoiceDate: r.supplierTaxInvoiceDate,
    supplierId: r.supplierId,
    purchaseOrderId: r.purchaseOrderId,
    billDate: r.billDate,
    dueDate: r.dueDate,
    currency: r.currency,
    subtotalCents: Number(r.subtotalCents ?? 0),
    vatCents: Number(r.vatCents ?? 0),
    whtCents: Number(r.whtCents ?? 0),
    totalCents: Number(r.totalCents ?? 0),
    paidCents: Number(r.paidCents ?? 0),
    whtPaidCents: Number(r.whtPaidCents ?? 0),
    remainingCents: Number(r.totalCents ?? 0) - Number(r.paidCents ?? 0),
    status: r.status as VendorBillStatus,
    matchStatus: r.matchStatus,
    journalEntryId: r.journalEntryId,
    paymentJournalEntryId: r.paymentJournalEntryId,
    postedAt: r.postedAt,
    paidAt: r.paidAt,
    voidedAt: r.voidedAt,
    notes: r.notes,
    createdAt: r.createdAt,
  };
}
function mapBill(header: any, lines: any[]) {
  return {
    ...mapBillHeader(header),
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      productId: l.productId,
      description: l.description,
      qty: Number(l.qty),
      unitPriceCents: Number(l.unitPriceCents),
      discountCents: Number(l.discountCents),
      netCents: Number(l.netCents),
      vatCategory: l.vatCategory,
      vatMode: l.vatMode,
      vatCents: Number(l.vatCents),
      whtCategory: l.whtCategory,
      whtRateBp: l.whtRateBp,
      whtCents: Number(l.whtCents),
      expenseAccountCode: l.expenseAccountCode,
      purchaseOrderLineId: l.purchaseOrderLineId,
      goodsReceiptLineId: l.goodsReceiptLineId,
      matchStatus: l.matchStatus,
      matchVarianceCents: l.matchVarianceCents,
    })),
  };
}
