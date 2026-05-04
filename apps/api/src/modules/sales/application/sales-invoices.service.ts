import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  computeThaiVat,
  computeWhtCents,
  whtRateBp,
  type ThaiVatCategory,
  type ThaiVatMode,
  type WhtCategory,
} from '@erp/shared';
import {
  chartOfAccounts,
  invoiceReceipts,
  partners,
  salesInvoiceLines,
  salesInvoices,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { SalesSequenceService } from '../infrastructure/sales-sequence.service';
import { JournalRepository } from '../../accounting/infrastructure/journal.repository';
import { OrganizationService } from '../../organization/organization.service';
import {
  JournalEntry,
  type JournalLine,
} from '../../accounting/domain/journal-entry';
import {
  allocateReceiptSplit,
  ReceiptAllocationError,
} from '../domain/receipt-allocation';

export type SalesInvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'cancelled';

export interface CreateInvoiceLineInput {
  productId?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  vatCategory?: ThaiVatCategory;
  vatMode?: ThaiVatMode;
  whtCategory?: WhtCategory | null;
  /**
   * Optional override for the WHT rate (in basis points). Honoured only when
   * `whtCategory` is also set. Use for legitimate edge cases — DTA reductions
   * on foreign payments, special-rate contracts. Must be 0–10000 (0%–100%).
   * If omitted, the statutory rate from `whtRateBp(category)` applies.
   */
  whtRateBpOverride?: number | null;
  /** Override the default revenue account (4110 product / 4120 service). */
  revenueAccountCode?: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  customerReference?: string;
  invoiceDate: string;
  dueDate?: string | null;
  paymentTermsDays?: number;
  currency?: string;
  vatMode?: ThaiVatMode;
  notes?: string;
  lines: CreateInvoiceLineInput[];
}

export interface RecordReceiptInput {
  /** Gross amount applied to AR for this receipt. */
  amountCents: number;
  /** Bank charge / merchant fee customer/bank deducted. We absorb to 6170. */
  bankChargeCents?: number;
  /** ISO date — defaults to today. */
  receiptDate?: string;
  cashAccountCode?: string;
  paymentMethod?: string;
  bankReference?: string;
  receivedBy?: string;
  notes?: string;
}

@Injectable()
export class SalesInvoicesService {
  private readonly logger = new Logger(SalesInvoicesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly seq: SalesSequenceService,
    private readonly journals: JournalRepository,
    private readonly org: OrganizationService,
  ) {}

  // ─── Create draft ────────────────────────────────────────────────────────
  async create(input: CreateInvoiceInput) {
    if (!input.lines?.length) {
      throw new BadRequestException('Invoice must have at least one line');
    }
    const customer = await this.requireCustomer(input.customerId);

    const lineSeeds = input.lines.map((l, i) => ({
      seedId: `seed-${i}`,
      input: l,
      net: Math.max(0, l.qty * l.unitPriceCents - (l.discountCents ?? 0)),
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

    const allocation = await this.seq.allocate('SI');

    const subtotal = lineSeeds.reduce((s, l) => s + l.net, 0);
    const vatTotal = vatResult.vatCents;
    // Resolve effective WHT rate per line — the override (if any) wins,
    // otherwise the statutory rate for the category. Validation is permissive
    // here (0–10000bp); calling code can choose to be stricter.
    const resolvedWhtRateBp = (input: CreateInvoiceLineInput): number | null => {
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
    const lineWhtCents = (net: number, input: CreateInvoiceLineInput): number => {
      const bp = resolvedWhtRateBp(input);
      if (bp == null) return 0;
      return Math.round((net * bp) / 10_000);
    };
    let whtTotal = 0;
    for (const seed of lineSeeds) {
      whtTotal += lineWhtCents(seed.net, seed.input);
    }
    // Total invoiced = gross. WHT does NOT change the invoice total — it
    // changes the cash received at receipt time.
    const total = vatResult.grossCents;

    const [row] = await this.db
      .insert(salesInvoices)
      .values({
        internalNumber: allocation.number,
        customerId: input.customerId,
        customerReference: input.customerReference ?? null,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        paymentTermsDays:
          input.paymentTermsDays ?? customer.paymentTermsDays ?? 30,
        currency: input.currency ?? 'THB',
        vatMode: input.vatMode ?? 'exclusive',
        subtotalCents: subtotal,
        vatCents: vatTotal,
        whtCents: whtTotal,
        totalCents: total,
        vatBreakdown: { lines: vatResult.perLine, vatCents: vatTotal } as any,
        notes: input.notes ?? null,
      })
      .returning();

    await this.db.insert(salesInvoiceLines).values(
      lineSeeds.map((seed, i) => {
        const lb = vatResult.perLine.find((p) => p.lineId === seed.seedId);
        const wht = lineWhtCents(seed.net, seed.input);
        return {
          salesInvoiceId: row.id,
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
          revenueAccountCode: seed.input.revenueAccountCode ?? null,
        };
      }),
    );

    this.logger.log(
      `Invoice ${allocation.number} draft for customer=${customer.name} (${input.lines.length} lines, total=${total} VAT=${vatTotal} WHT=${whtTotal})`,
    );
    return this.findById(row.id);
  }

  // ─── Send (post AR journal) ──────────────────────────────────────────────
  async send(invoiceId: string, options: { sentBy?: string } = {}) {
    const inv = await this.findById(invoiceId);
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (inv.status !== 'draft') {
      throw new BadRequestException(`Invoice is ${inv.status}; only draft can be sent`);
    }

    // Build the AR journal:
    //   Dr 1141 Accounts receivable    (totalCents)
    //     Cr 4110 / 4120 / override    (line netCents — revenue per line)
    //     Cr 2201 Output VAT           (vatCents)
    const lines: JournalLine[] = [
      {
        accountCode: '1141',
        accountName: 'AR — trade',
        debitCents: inv.totalCents,
        creditCents: 0,
        description: `Receivable from ${inv.customerId}`,
        partnerId: inv.customerId,
      },
    ];
    for (const l of inv.lines) {
      const account = l.revenueAccountCode
        ? l.revenueAccountCode
        : l.productId
        ? '4110'
        : '4120';
      lines.push({
        accountCode: account,
        accountName: l.revenueAccountCode
          ? `Revenue ${l.revenueAccountCode}`
          : l.productId
          ? 'Sales — products'
          : 'Service revenue',
        debitCents: 0,
        creditCents: l.netCents,
        description: l.description,
      });
    }
    if (inv.vatCents > 0) {
      lines.push({
        accountCode: '2201',
        accountName: 'Output VAT',
        debitCents: 0,
        creditCents: inv.vatCents,
        description: `Output VAT for ${inv.internalNumber}`,
      });
    }

    const entry = JournalEntry.create({
      date: inv.invoiceDate,
      description: `Sales invoice ${inv.internalNumber}`,
      reference: inv.customerReference ?? null,
      sourceModule: 'sales.invoice',
      sourceId: inv.id,
      currency: inv.currency,
      lines,
    });
    const posted = await this.journals.insert(entry, {
      autoPost: true,
      postedBy: isUuid(options.sentBy) ? (options.sentBy as string) : null,
    });

    await this.db
      .update(salesInvoices)
      .set({
        status: 'sent',
        journalEntryId: posted.id,
        sentAt: new Date(),
        sentBy: options.sentBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, invoiceId));

    this.logger.log(
      `Invoice ${inv.internalNumber} sent — journal #${posted.entryNumber}`,
    );
    return this.findById(invoiceId);
  }

  // ─── Record one receipt (creates payment GL entry) ───────────────────────
  /**
   * Adds one receipt against a sent invoice. Computes the proportional
   * WHT/cash split via `allocateReceiptSplit` and writes:
   *
   *   invoice_receipts  one row (next receiptNo, source-of-truth slice)
   *   journal_entries   Dr cash + Dr 1157 + Dr 6170 / Cr 1141
   *   sales_invoices    paidCents/whtReceivedCents updated; status flips to
   *                     partially_paid (mid) or paid (when balance reaches zero)
   *
   * Concurrency: SELECT FOR UPDATE on the invoice row serialises receipts.
   * The (sales_invoice_id, receipt_no) UNIQUE backstops races.
   */
  async recordReceipt(invoiceId: string, input: RecordReceiptInput) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new BadRequestException(
        `amountCents must be a positive integer (got ${input.amountCents})`,
      );
    }
    const cashAccount = input.cashAccountCode ?? '1120';
    const receiptDate =
      input.receiptDate ?? new Date().toISOString().slice(0, 10);

    // Resolve the cash account's display name from CoA so the journal line
    // shows the right label even for accounts beyond 1110/1120 (e.g. a third
    // bank the user added with is_cash_account=true).
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
      const invRows = await tx
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.id, invoiceId))
        .limit(1)
        .for('update');
      const invRow = invRows[0];
      if (!invRow) throw new NotFoundException(`Invoice ${invoiceId} not found`);
      const status = invRow.status as SalesInvoiceStatus;
      if (status !== 'sent' && status !== 'partially_paid') {
        throw new BadRequestException(
          `Invoice is ${status}; only sent/partially_paid invoices can receive payments`,
        );
      }

      const invTotal = Number(invRow.totalCents);
      const invWht = Number(invRow.whtCents);
      const paidSoFar = Number(invRow.paidCents ?? 0);
      const whtSoFar = Number(invRow.whtReceivedCents ?? 0);

      let split;
      try {
        split = allocateReceiptSplit({
          amountCents: input.amountCents,
          bankChargeCents: input.bankChargeCents ?? 0,
          invoiceTotalCents: invTotal,
          invoiceWhtCents: invWht,
          paidCentsSoFar: paidSoFar,
          whtReceivedCentsSoFar: whtSoFar,
        });
      } catch (e) {
        if (e instanceof ReceiptAllocationError) {
          throw new BadRequestException(`${e.code}: ${e.message}`);
        }
        throw e;
      }

      const maxRow = await tx
        .select({
          maxNo: sql<number>`coalesce(max(${invoiceReceipts.receiptNo}), 0)`,
        })
        .from(invoiceReceipts)
        .where(eq(invoiceReceipts.salesInvoiceId, invoiceId));
      const receiptNo = Number(maxRow[0]?.maxNo ?? 0) + 1;

      // Build + post the journal
      const lines: JournalLine[] = [
        {
          accountCode: cashAccount,
          accountName: cashAccountName,
          debitCents: split.cashCents,
          creditCents: 0,
          description: `Receipt #${receiptNo} of ${invRow.internalNumber}`,
        },
      ];
      if (split.whtCents > 0) {
        lines.push({
          accountCode: '1157',
          accountName: 'WHT receivable',
          debitCents: split.whtCents,
          creditCents: 0,
          description: `WHT withheld by customer (${invRow.internalNumber} #${receiptNo})`,
        });
      }
      if (split.bankChargeCents > 0) {
        const settings = await this.org.snapshot();
        lines.push({
          accountCode: settings.defaultBankChargeAccount,
          accountName: 'Bank charge',
          debitCents: split.bankChargeCents,
          creditCents: 0,
          description: `Bank fee on ${invRow.internalNumber} #${receiptNo}`,
        });
      }
      lines.push({
        accountCode: '1141',
        accountName: 'AR — trade',
        debitCents: 0,
        creditCents: input.amountCents,
        description: `Settlement #${receiptNo} of ${invRow.internalNumber}`,
        partnerId: invRow.customerId,
      });

      const entry = JournalEntry.create({
        date: receiptDate,
        description: `Receipt #${receiptNo} for ${invRow.internalNumber}`,
        reference: invRow.internalNumber,
        sourceModule: 'sales.invoice-receipt',
        sourceId: `${invRow.id}:${receiptNo}`,
        currency: invRow.currency,
        lines,
      });
      const posted = await this.journals.insert(entry, {
        autoPost: true,
        postedBy: isUuid(input.receivedBy) ? (input.receivedBy as string) : null,
      });

      await tx.insert(invoiceReceipts).values({
        salesInvoiceId: invoiceId,
        receiptNo,
        receiptDate,
        amountCents: input.amountCents,
        whtCents: split.whtCents,
        bankChargeCents: split.bankChargeCents,
        cashCents: split.cashCents,
        cashAccountCode: cashAccount,
        paymentMethod: input.paymentMethod ?? null,
        bankReference: input.bankReference ?? null,
        journalEntryId: posted.id,
        receivedBy: input.receivedBy ?? null,
        notes: input.notes ?? null,
      });

      const nextStatus: SalesInvoiceStatus = split.isFinal
        ? 'paid'
        : 'partially_paid';
      await tx
        .update(salesInvoices)
        .set({
          paidCents: split.newPaidCents,
          whtReceivedCents: split.newWhtReceivedCents,
          status: nextStatus,
          paymentJournalEntryId: posted.id,
          paidAt: split.isFinal ? new Date() : null,
          paidBy: split.isFinal ? input.receivedBy ?? null : null,
          updatedAt: new Date(),
        })
        .where(eq(salesInvoices.id, invoiceId));

      this.logger.log(
        `Invoice ${invRow.internalNumber} receipt #${receiptNo} via ${cashAccount} amt=${input.amountCents} cash=${split.cashCents} WHT=${split.whtCents} → ${nextStatus}`,
      );
      return { receiptNo, journalEntryId: posted.id, allocation: split };
    });
  }

  // ─── Cancel ──────────────────────────────────────────────────────────────
  async cancel(invoiceId: string, reason: string, cancelledBy?: string) {
    const inv = await this.findById(invoiceId);
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (inv.status === 'cancelled') return inv;
    if (inv.status === 'paid' || inv.status === 'partially_paid') {
      throw new BadRequestException(
        'Cannot cancel an invoice with receipts. Void each receipt first, then cancel.',
      );
    }
    if (inv.status === 'sent' && inv.journalEntryId) {
      await this.journals.void(inv.journalEntryId, reason, cancelledBy ?? null);
    }
    await this.db
      .update(salesInvoices)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledReason: reason,
        cancelledBy: cancelledBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, invoiceId));
    return this.findById(invoiceId);
  }

  // ─── Void one receipt ────────────────────────────────────────────────────
  /**
   * Void a single receipt. Inserts a reversing JE (Dr↔Cr swap of the original
   * receipt JE) via JournalRepository.void(), marks the invoice_receipts row
   * voided, and rolls back the invoice's running totals.
   *
   * State transitions:
   *   paid           → partially_paid   (other non-voided receipts remain)
   *   paid           → sent             (this was the only receipt)
   *   partially_paid → partially_paid   (still has other receipts)
   *   partially_paid → sent             (no other receipts)
   *
   * Idempotent: voiding an already-voided row → 400.
   * Concurrency: SELECT FOR UPDATE on the invoice row serialises with
   * recordReceipt so a void can't race with a new receipt.
   */
  async voidReceipt(
    invoiceId: string,
    receiptNo: number,
    reason: string,
    voidedBy?: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Void reason required (≥3 chars)');
    }

    const invRows = await this.db
      .select()
      .from(salesInvoices)
      .where(eq(salesInvoices.id, invoiceId))
      .limit(1)
      .for('update');
    const invRow = invRows[0];
    if (!invRow) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    const [rcpt] = await this.db
      .select()
      .from(invoiceReceipts)
      .where(
        and(
          eq(invoiceReceipts.salesInvoiceId, invoiceId),
          eq(invoiceReceipts.receiptNo, receiptNo),
        ),
      )
      .limit(1);
    if (!rcpt) {
      throw new NotFoundException(
        `Receipt #${receiptNo} not found on invoice ${invoiceId}`,
      );
    }
    if (rcpt.voidedAt) {
      throw new BadRequestException(
        `Receipt #${receiptNo} already voided at ${rcpt.voidedAt.toISOString()}`,
      );
    }
    if (!rcpt.journalEntryId) {
      throw new BadRequestException(
        `Receipt #${receiptNo} has no journal entry to reverse`,
      );
    }

    // Reverse the JE — commits independently. Same trade-off as recordReceipt:
    // dangling reversal flagged by nightly reconcile if our updates fail.
    await this.journals.void(
      rcpt.journalEntryId,
      `Void receipt #${receiptNo} of ${invRow.internalNumber}: ${reason}`,
      isUuid(voidedBy) ? (voidedBy as string) : null,
    );

    await this.db
      .update(invoiceReceipts)
      .set({ voidedAt: new Date(), voidReason: reason })
      .where(eq(invoiceReceipts.id, rcpt.id));

    const live = await this.db
      .select({
        paid: sql<number>`coalesce(sum(${invoiceReceipts.amountCents}), 0)::bigint`,
        wht: sql<number>`coalesce(sum(${invoiceReceipts.whtCents}), 0)::bigint`,
      })
      .from(invoiceReceipts)
      .where(
        and(
          eq(invoiceReceipts.salesInvoiceId, invoiceId),
          isNull(invoiceReceipts.voidedAt),
        ),
      );
    const newPaid = Number(live[0]?.paid ?? 0);
    const newWht = Number(live[0]?.wht ?? 0);

    const [latest] = await this.db
      .select({ jeId: invoiceReceipts.journalEntryId })
      .from(invoiceReceipts)
      .where(
        and(
          eq(invoiceReceipts.salesInvoiceId, invoiceId),
          isNull(invoiceReceipts.voidedAt),
        ),
      )
      .orderBy(desc(invoiceReceipts.receiptNo))
      .limit(1);

    const invTotal = Number(invRow.totalCents);
    let nextStatus: SalesInvoiceStatus;
    if (newPaid >= invTotal) nextStatus = 'paid';
    else if (newPaid > 0) nextStatus = 'partially_paid';
    else nextStatus = 'sent';

    await this.db
      .update(salesInvoices)
      .set({
        paidCents: newPaid,
        whtReceivedCents: newWht,
        status: nextStatus,
        paymentJournalEntryId: latest?.jeId ?? null,
        paidAt: nextStatus === 'paid' ? invRow.paidAt : null,
        paidBy: nextStatus === 'paid' ? invRow.paidBy : null,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, invoiceId));

    this.logger.log(
      `Invoice ${invRow.internalNumber} receipt #${receiptNo} voided (reason="${reason}") → status=${nextStatus} paid=${newPaid} wht=${newWht}`,
    );
    return {
      receiptNo,
      voidedAt: new Date(),
      reason,
      newStatus: nextStatus,
      newPaidCents: newPaid,
      newWhtReceivedCents: newWht,
    };
  }

  // ─── List receipts ───────────────────────────────────────────────────────
  async listReceipts(invoiceId: string) {
    const rows = await this.db
      .select()
      .from(invoiceReceipts)
      .where(eq(invoiceReceipts.salesInvoiceId, invoiceId))
      .orderBy(invoiceReceipts.receiptNo);
    return rows.map((r) => ({
      id: r.id,
      receiptNo: r.receiptNo,
      receiptDate: r.receiptDate,
      amountCents: Number(r.amountCents),
      whtCents: Number(r.whtCents),
      bankChargeCents: Number(r.bankChargeCents ?? 0),
      cashCents: Number(r.cashCents),
      cashAccountCode: r.cashAccountCode,
      paymentMethod: r.paymentMethod,
      bankReference: r.bankReference,
      journalEntryId: r.journalEntryId,
      receivedBy: r.receivedBy,
      notes: r.notes,
      voidedAt: r.voidedAt,
      voidReason: r.voidReason,
      createdAt: r.createdAt,
    }));
  }

  // ─── Read ────────────────────────────────────────────────────────────────
  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(salesInvoices)
      .where(eq(salesInvoices.id, id))
      .limit(1);
    if (!rows[0]) return null;
    const lines = await this.db
      .select()
      .from(salesInvoiceLines)
      .where(eq(salesInvoiceLines.salesInvoiceId, id))
      .orderBy(salesInvoiceLines.lineNo);
    return mapInvoice(rows[0], lines);
  }

  async list(opts: {
    customerId?: string;
    status?: SalesInvoiceStatus;
    limit?: number;
  } = {}) {
    const where = [] as any[];
    if (opts.customerId) where.push(eq(salesInvoices.customerId, opts.customerId));
    if (opts.status) where.push(eq(salesInvoices.status, opts.status));
    const rows = await this.db
      .select()
      .from(salesInvoices)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(salesInvoices.invoiceDate))
      .limit(Math.min(500, opts.limit ?? 100));
    return rows.map((r) => mapInvoiceHeader(r));
  }

  private async requireCustomer(id: string) {
    const rows = await this.db
      .select({
        id: partners.id,
        name: partners.name,
        isCustomer: partners.isCustomer,
        paymentTermsDays: partners.paymentTermsDays,
      })
      .from(partners)
      .where(eq(partners.id, id))
      .limit(1);
    if (!rows[0]) throw new BadRequestException(`Customer ${id} not found`);
    if (!rows[0].isCustomer) {
      throw new BadRequestException(`Partner ${id} is not flagged as a customer`);
    }
    return rows[0];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

function mapInvoiceHeader(r: any) {
  return {
    id: r.id,
    internalNumber: r.internalNumber,
    customerId: r.customerId,
    customerReference: r.customerReference,
    invoiceDate: r.invoiceDate,
    dueDate: r.dueDate,
    paymentTermsDays: r.paymentTermsDays,
    currency: r.currency,
    vatMode: r.vatMode,
    subtotalCents: Number(r.subtotalCents ?? 0),
    discountCents: Number(r.discountCents ?? 0),
    vatCents: Number(r.vatCents ?? 0),
    whtCents: Number(r.whtCents ?? 0),
    totalCents: Number(r.totalCents ?? 0),
    paidCents: Number(r.paidCents ?? 0),
    whtReceivedCents: Number(r.whtReceivedCents ?? 0),
    remainingCents: Number(r.totalCents ?? 0) - Number(r.paidCents ?? 0),
    status: r.status as SalesInvoiceStatus,
    journalEntryId: r.journalEntryId,
    paymentJournalEntryId: r.paymentJournalEntryId,
    pp30FilingId: r.pp30FilingId,
    sentAt: r.sentAt,
    paidAt: r.paidAt,
    cancelledAt: r.cancelledAt,
    notes: r.notes,
    createdAt: r.createdAt,
  };
}

function mapInvoice(header: any, lines: any[]) {
  return {
    ...mapInvoiceHeader(header),
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
      revenueAccountCode: l.revenueAccountCode,
    })),
  };
}
