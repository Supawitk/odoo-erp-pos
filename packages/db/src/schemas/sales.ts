import {
  uuid,
  text,
  bigint,
  varchar,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  integer,
  date,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';

/**
 * AR — Sales Invoices (credit B2B), back-office equivalent of the POS-issued
 * Tax Invoice. Mechanically still a §86/4 full tax invoice; the SI prefix is
 * an internal partition so back-office invoicing doesn't share a sequence with
 * the POS terminal counters.
 *
 * Posting (state: draft → sent):
 *   Dr 1141 Accounts receivable        (totalCents)
 *     Cr 4110 Sales / 4120 Service     (subtotal − discount per line account)
 *     Cr 2201 Output VAT               (vatCents)
 *
 * Receiving (state: sent / partially_paid → partially_paid / paid):
 *   Dr 1120 Bank                       (cashCents)
 *   Dr 1157 WHT receivable             (whtCents — customer withheld)
 *   Dr 6170 Bank charge                (bankChargeCents — we eat)
 *     Cr 1141 Accounts receivable      (amountCents)
 *
 * The customer-side WHT lives at 1157 because we're the payee — it's an asset
 * we'll offset against PND.50 CIT at year-end.
 *
 * Cancelling a sent invoice reverses the posting JE (full reversal). Receipts
 * are voided individually (each gets its own reversal JE).
 *
 * pp30FilingId is set when the invoice's output VAT was settled in a PP.30
 * close. Read this when computing PP.30 box totals so already-closed periods
 * can't be re-claimed.
 */
export const salesInvoices = customSchema.table(
  'sales_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Internal sequence SI-YYMM-#####. */
    internalNumber: varchar('internal_number', { length: 32 }).notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Customer's PO number / their internal reference. Not validated. */
    customerReference: text('customer_reference'),
    invoiceDate: date('invoice_date').notNull(),
    /** If null, defaults to invoiceDate + paymentTermsDays. */
    dueDate: date('due_date'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    fxRateToThb: numeric('fx_rate_to_thb', { precision: 14, scale: 6 }).default('1.0'),
    vatMode: text('vat_mode').notNull().default('exclusive'),
    /** Snapshot totals (computed from lines + VAT engine). */
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    /** Expected WHT customer will withhold (Σ line whtCents). Advisory; actual
     * WHT recognised on each receipt. */
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    vatBreakdown: jsonb('vat_breakdown'),
    status: text('status').notNull().default('draft'), // draft | sent | partially_paid | paid | cancelled
    journalEntryId: uuid('journal_entry_id'),
    paymentJournalEntryId: uuid('payment_journal_entry_id'),
    /** Running totals across non-voided receipts. paidCents == totalCents → fully paid. */
    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    whtReceivedCents: bigint('wht_received_cents', { mode: 'number' }).notNull().default(0),
    /** When PP.30 was closed for this invoice's period. Locks the row from re-claiming. */
    pp30FilingId: uuid('pp30_filing_id'),
    notes: text('notes'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: text('sent_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidBy: text('paid_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: text('cancelled_reason'),
    cancelledBy: text('cancelled_by'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    internalNumberUnique: uniqueIndex('sales_invoices_internal_number_idx').on(
      table.internalNumber,
    ),
    customerIdx: index('sales_invoices_customer_idx').on(table.customerId),
    customerStatusIdx: index('sales_invoices_customer_status_idx').on(
      table.customerId,
      table.status,
    ),
    invoiceDateIdx: index('sales_invoices_invoice_date_idx').on(table.invoiceDate),
    statusIdx: index('sales_invoices_status_idx').on(table.status),
  }),
);

export const salesInvoiceLines = customSchema.table(
  'sales_invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salesInvoiceId: uuid('sales_invoice_id').notNull(),
    lineNo: integer('line_no').notNull(),
    /** Optional — service lines (consulting, rent receivable) don't reference a product. */
    productId: uuid('product_id'),
    description: text('description').notNull(),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    netCents: bigint('net_cents', { mode: 'number' }).notNull(),
    vatCategory: text('vat_category').notNull().default('standard'), // standard | zero_rated | exempt
    vatMode: text('vat_mode').notNull().default('exclusive'),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    /** WHT category if customer will withhold (services 3%, rent 5%, ads 2%, freight 1%). */
    whtCategory: text('wht_category'),
    whtRateBp: integer('wht_rate_bp'),
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    /** Revenue-account override. Defaults: 4110 product, 4120 service. */
    revenueAccountCode: varchar('revenue_account_code', { length: 10 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    invoiceLineUnique: uniqueIndex('sil_invoice_lineno_idx').on(
      table.salesInvoiceId,
      table.lineNo,
    ),
    productIdx: index('sil_product_idx').on(table.productId),
  }),
);

/**
 * One row per receipt against an invoice. An invoice can be settled in 1..N
 * receipts. Per-receipt journal:
 *
 *   Dr 1120 Bank                      (cashCents)
 *   Dr 1157 WHT receivable            (whtCents — customer-withheld)
 *   Dr 6170 Bank charge               (bankChargeCents — fees we absorb)
 *     Cr 1141 Accounts receivable     (amountCents)
 *
 * WHT split rule (so totals reconcile to invoice.whtCents):
 *   non-final receipt: whtCents = floor(amountCents × invoice.whtCents / invoice.totalCents)
 *   final receipt:     whtCents = invoice.whtCents − Σ prior whtCents
 *
 * Customer typically issues us a 50-Tawi for each WHT amount, which we file
 * for input-credit against PND.50 CIT.
 */
export const invoiceReceipts = customSchema.table(
  'invoice_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salesInvoiceId: uuid('sales_invoice_id').notNull(),
    receiptNo: integer('receipt_no').notNull(),
    receiptDate: date('receipt_date').notNull(),
    /** Gross amount applied to AR for this receipt. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** WHT recognised on this receipt (allocated proportionally + remainder-on-last). */
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    /** Bank charge / merchant fee deducted from settlement (we absorb to 6170). */
    bankChargeCents: bigint('bank_charge_cents', { mode: 'number' }).notNull().default(0),
    /** Cash actually received = amount − wht − bankCharge. */
    cashCents: bigint('cash_cents', { mode: 'number' }).notNull(),
    /** 1110 cash / 1120 bank — caller picks. */
    cashAccountCode: varchar('cash_account_code', { length: 10 }).notNull().default('1120'),
    paymentMethod: text('payment_method'), // bank_transfer | cheque | cash | promptpay | card
    bankReference: text('bank_reference'),
    journalEntryId: uuid('journal_entry_id'),
    receivedBy: text('received_by'),
    notes: text('notes'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    receiptNoUnique: uniqueIndex('invoice_receipts_inv_no_idx').on(
      table.salesInvoiceId,
      table.receiptNo,
    ),
    invoiceDateIdx: index('invoice_receipts_inv_date_idx').on(
      table.salesInvoiceId,
      table.receiptDate,
    ),
    receiptDateIdx: index('invoice_receipts_date_idx').on(table.receiptDate),
  }),
);
