import { Inject, Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  computeThaiVat,
  type ThaiVatCategory,
  type ThaiVatMode,
} from '@erp/shared';
import {
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

export type VendorBillStatus = 'draft' | 'posted' | 'paid' | 'void';

export interface CreateVendorBillLineInput {
  productId?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  vatCategory?: ThaiVatCategory;
  vatMode?: ThaiVatMode;
  whtCategory?: WhtCategory | null;
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

@Injectable()
export class VendorBillsService {
  private readonly logger = new Logger(VendorBillsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly seq: PurchasingSequenceService,
    private readonly journals: JournalRepository,
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
    let whtTotal = 0;
    for (const seed of lineSeeds) {
      whtTotal += computeWhtCents(seed.net, seed.input.whtCategory);
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
        const wht = computeWhtCents(seed.net, seed.input.whtCategory);
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
          whtRateBp: seed.input.whtCategory ? whtRateBp(seed.input.whtCategory) : null,
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

  // ─── Pay (creates payment GL entry) ────────────────────────────────────
  async pay(billId: string, input: PayVendorBillInput = {}) {
    const bill = await this.findById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    if (bill.status !== 'posted') {
      throw new BadRequestException(
        `Bill is ${bill.status}; only posted bills can be paid`,
      );
    }
    const cashAccount = input.cashAccountCode ?? '1120'; // Bank — checking
    const paidDate = input.paidDate ?? new Date().toISOString().slice(0, 10);

    const lines: JournalLine[] = [
      {
        accountCode: '2110',
        accountName: 'AP — trade',
        debitCents: bill.totalCents,
        creditCents: 0,
        description: `Settlement of ${bill.internalNumber}`,
        partnerId: bill.supplierId,
      },
    ];

    const cashOut = bill.totalCents - bill.whtCents;
    lines.push({
      accountCode: cashAccount,
      accountName: cashAccount === '1110' ? 'Cash on hand' : 'Bank — checking',
      debitCents: 0,
      creditCents: cashOut,
    });

    if (bill.whtCents > 0) {
      lines.push({
        accountCode: '2203',
        accountName: 'WHT payable',
        debitCents: 0,
        creditCents: bill.whtCents,
        description: `WHT withheld from ${bill.internalNumber}`,
      });
    }

    const entry = JournalEntry.create({
      date: paidDate,
      description: `Payment for ${bill.internalNumber}`,
      reference: bill.internalNumber,
      sourceModule: 'purchasing.bill-payment',
      sourceId: bill.id,
      currency: bill.currency,
      lines,
    });
    const posted = await this.journals.insert(entry, {
      autoPost: true,
      postedBy: isUuid(input.paidBy) ? (input.paidBy as string) : null,
    });

    await this.db
      .update(vendorBills)
      .set({
        status: 'paid',
        paymentJournalEntryId: posted.id,
        paidAt: new Date(),
        paidBy: input.paidBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(vendorBills.id, billId));

    this.logger.log(
      `Bill ${bill.internalNumber} paid via ${cashAccount} (cash=${cashOut} WHT=${bill.whtCents})`,
    );
    return this.findById(billId);
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
