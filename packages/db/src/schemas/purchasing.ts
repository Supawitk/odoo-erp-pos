import {
  uuid,
  text,
  bigint,
  varchar,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  boolean,
  integer,
  date,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';
import { bytea } from './_types';

/**
 * Phase 3 Batch 3 — Suppliers, Purchase Orders, Goods Receipts.
 *
 * Design refs (Phase 3 Pre-Phase Research Log):
 *   - Frappe ERPNext supplier+purchase model
 *   - Odoo purchase.order + purchase.order.line + stock.picking triad
 *   - OCA/purchase-workflow 18.0 (purchase_order_line_description, etc.)
 *   - 🇹🇭 OCA/l10n_th_partner — TIN, branch_code, vat_registered, WHT category
 *
 * Three-way match (PO ↔ GRN ↔ Vendor Bill) → Phase 4 (vendor bills).
 */

// ─── Unified business partners ──────────────────────────────────────────────
/**
 * BP-style: one table for suppliers / customers / employees, distinguished by
 * the role flags. A single entity can be more than one role (e.g. a supplier
 * who is also a customer).
 *
 * Thai fields (TIN, branch_code, vat_registered) — gate input-VAT claim under
 * §82/3. Mod-11 validation enforced at the application layer.
 */
export const partners = customSchema.table(
  'partners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isCustomer: boolean('is_customer').notNull().default(false),
    isEmployee: boolean('is_employee').notNull().default(false),
    email: text('email'),
    phone: text('phone'),
    /** 13-digit Thai TIN; mod-11 validated by @erp/shared/thai/tin.
     *  KEPT plaintext for transitional reads — new writes also populate
     *  tinEncrypted (pgcrypto ciphertext) + tinHash (sha256 hex). Drop after
     *  full read-path migration. */
    tin: varchar('tin', { length: 13 }),
    /** pgcrypto pgp_sym_encrypt(tin, ENCRYPTION_MASTER_KEY) — see EncryptionService. */
    tinEncrypted: bytea('tin_encrypted'),
    /** sha256 hex of plaintext TIN — for indexed equality lookup. */
    tinHash: text('tin_hash'),
    /** 5-digit Thai branch code, default '00000' for HQ. */
    branchCode: varchar('branch_code', { length: 5 }).default('00000'),
    vatRegistered: boolean('vat_registered').notNull().default(false),
    /** Address as JSON so we can localise — { line1, line2, district, province, postalCode, country } */
    address: jsonb('address'),
    defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('THB'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    /** WHT category for AP flow (Phase 4). Maps to OCA l10n_th_partner.supplier_wht_tax_id. */
    whtCategory: text('wht_category'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    nameIdx: index('partners_name_idx').on(table.name),
    supplierIdx: index('partners_supplier_idx').on(table.isSupplier),
    customerIdx: index('partners_customer_idx').on(table.isCustomer),
    tinIdx: uniqueIndex('partners_tin_branch_idx').on(table.tin, table.branchCode),
    tinHashIdx: index('partners_tin_hash_idx').on(table.tinHash),
    activeIdx: index('partners_active_idx').on(table.isActive),
  }),
);

// ─── Purchase orders ────────────────────────────────────────────────────────
/**
 * State machine:
 *   draft → confirmed → partial_received → received → cancelled
 *                                       ↘ cancelled
 *
 * Sequence: PO-YYMM-##### via document_sequences (same allocator as TX/ABB).
 *
 * Currency: defaults to THB. Foreign currency must lock fx_rate_to_thb at the
 * order date (Phase 4 will populate via the BoT FX puller).
 */
export const purchaseOrders = customSchema.table(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poNumber: varchar('po_number', { length: 32 }).notNull(),
    supplierId: uuid('supplier_id').notNull(),
    status: text('status').notNull().default('draft'), // draft | confirmed | partial_received | received | cancelled
    orderDate: date('order_date').notNull(),
    expectedDeliveryDate: date('expected_delivery_date'),
    destinationWarehouseId: uuid('destination_warehouse_id').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    fxRateToThb: numeric('fx_rate_to_thb', { precision: 14, scale: 6 }).default('1.0'),
    /** vat mode — inclusive | exclusive. Stored on PO so vendor bills inherit it. */
    vatMode: text('vat_mode').notNull().default('exclusive'),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    vatBreakdown: jsonb('vat_breakdown'),
    notes: text('notes'),
    createdBy: text('created_by'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    poNumberUnique: uniqueIndex('purchase_orders_po_number_idx').on(table.poNumber),
    supplierStatusIdx: index('purchase_orders_supplier_status_idx').on(
      table.supplierId,
      table.status,
    ),
    orderDateIdx: index('purchase_orders_order_date_idx').on(table.orderDate),
    statusIdx: index('purchase_orders_status_idx').on(table.status),
  }),
);

export const purchaseOrderLines = customSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    description: text('description'),
    qtyOrdered: numeric('qty_ordered', { precision: 14, scale: 3 }).notNull(),
    qtyReceived: numeric('qty_received', { precision: 14, scale: 3 }).notNull().default('0'),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    /** vat category snapshot at PO creation (so vendor changes don't break this PO). */
    vatCategory: text('vat_category').notNull().default('standard'),
    /** Excise pre-VAT cents per line — Phase 3 hydration mirror of POS pricing. */
    exciseCents: bigint('excise_cents', { mode: 'number' }).notNull().default(0),
    lineTotalCents: bigint('line_total_cents', { mode: 'number' }).notNull(),
  },
  (table) => ({
    poLineUnique: uniqueIndex('po_lines_po_lineno_idx').on(
      table.purchaseOrderId,
      table.lineNo,
    ),
    productIdx: index('po_lines_product_idx').on(table.productId),
  }),
);

/**
 * Immutable audit log of PO changes (price, qty, vendor). §65 CIT
 * deductibility evidence — every change must be traceable.
 */
export const purchaseOrderAmendments = customSchema.table(
  'purchase_order_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    version: integer('version').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    amendedBy: text('amended_by'),
    amendedAt: timestamp('amended_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    poVersionIdx: index('po_amendments_po_version_idx').on(
      table.purchaseOrderId,
      table.version,
    ),
  }),
);

// ─── Goods receipts ─────────────────────────────────────────────────────────
/**
 * GRN per shipment. One PO can have N GRNs (partial deliveries). Each GRN line
 * carries QC status:
 *   pending | passed | failed | quarantine
 * Only `passed` lines bump stock_quants + create cost_layers. Failed/quarantine
 * sit on the GRN until disposition (return, write-off, retest).
 */
export const goodsReceipts = customSchema.table(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grnNumber: varchar('grn_number', { length: 32 }).notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    receivedDate: date('received_date').notNull(),
    destinationWarehouseId: uuid('destination_warehouse_id').notNull(),
    supplierDeliveryNote: text('supplier_delivery_note'),
    status: text('status').notNull().default('draft'), // draft | posted | cancelled
    receivedBy: text('received_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    grnNumberUnique: uniqueIndex('goods_receipts_grn_number_idx').on(table.grnNumber),
    poStatusIdx: index('goods_receipts_po_status_idx').on(
      table.purchaseOrderId,
      table.status,
    ),
    receivedDateIdx: index('goods_receipts_received_date_idx').on(table.receivedDate),
  }),
);

export const goodsReceiptLines = customSchema.table(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    purchaseOrderLineId: uuid('purchase_order_line_id').notNull(),
    productId: uuid('product_id').notNull(),
    qtyReceived: numeric('qty_received', { precision: 14, scale: 3 }).notNull(),
    qtyAccepted: numeric('qty_accepted', { precision: 14, scale: 3 }).notNull().default('0'),
    qtyRejected: numeric('qty_rejected', { precision: 14, scale: 3 }).notNull().default('0'),
    qcStatus: text('qc_status').notNull().default('pending'), // pending | passed | failed | quarantine
    qcNotes: text('qc_notes'),
    /** unit cost from PO (or override on receipt for cost adjustments) — drives cost_layer creation */
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
    /** Optional lot/serial/expiry fields populated at receipt time. */
    lotCode: text('lot_code'),
    serialNo: text('serial_no'),
    expiryDate: date('expiry_date'),
    /** Back-pointer to the cost_layer once posted. */
    costLayerId: uuid('cost_layer_id'),
  },
  (table) => ({
    grnLineIdx: index('grn_lines_grn_idx').on(table.goodsReceiptId),
    poLineIdx: index('grn_lines_po_line_idx').on(table.purchaseOrderLineId),
    productIdx: index('grn_lines_product_idx').on(table.productId),
    qcStatusIdx: index('grn_lines_qc_status_idx').on(table.qcStatus),
  }),
);

// ─── Vendor bills (3-way match: PO ↔ GRN ↔ Bill) ───────────────────────────
/**
 * The supplier's tax invoice, recorded against an optional PO and GRN. Posting
 * a bill creates the AP journal:
 *
 *   Dr expense (5xxx COGS / 6xxx OpEx, per line)
 *   Dr 1155 Input VAT          (if vat-registered seller + claimable)
 *     Cr 2110 Accounts payable
 *
 * Paying it creates:
 *
 *   Dr 2110 Accounts payable
 *     Cr 1120 Bank — checking
 *     Cr 2203 WHT payable      (if WHT applies — gives rise to 50-Tawi)
 *
 * Three-way match runs at post time: per line, qty ≤ GRN qty_received and
 * unit_price within tolerance of PO unit_price. Mismatches block the post
 * unless an `overrideMatchBy` is supplied (e.g. supervisor approval).
 */
export const vendorBills = customSchema.table(
  'vendor_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Our internal sequence VB-YYMM-#####. */
    internalNumber: varchar('internal_number', { length: 32 }).notNull(),
    /** Supplier's invoice number from the paper bill. May not be unique across suppliers. */
    supplierInvoiceNumber: text('supplier_invoice_number'),
    /** Supplier's tax invoice fields — captured to claim input VAT (§82/3). */
    supplierTaxInvoiceNumber: text('supplier_tax_invoice_number'),
    supplierTaxInvoiceDate: date('supplier_tax_invoice_date'),
    supplierId: uuid('supplier_id').notNull(),
    /** Optional — services-only bills don't have a PO. */
    purchaseOrderId: uuid('purchase_order_id'),
    billDate: date('bill_date').notNull(),
    dueDate: date('due_date'),
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    /** Snapshot totals (computed from lines + VAT engine). */
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    vatBreakdown: jsonb('vat_breakdown'),
    status: text('status').notNull().default('draft'), // draft | posted | partially_paid | paid | void
    /** GL link — populated on post / pay. */
    journalEntryId: uuid('journal_entry_id'),
    /** Last payment journal — null for fully-unpaid posts; latest installment when paid/partially_paid. */
    paymentJournalEntryId: uuid('payment_journal_entry_id'),
    /** Running totals across the bill_payments rows. paidCents == totalCents → fully paid. */
    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    whtPaidCents: bigint('wht_paid_cents', { mode: 'number' }).notNull().default(0),
    /**
     * 🇹🇭 Input VAT 6-month reclass (§82/3). When input VAT goes unclaimed past
     * the 6-month window it's permanently lost; the cron books Dr 6390 / Cr 1155
     * to move the receivable into a CIT-deductible expense. Stamping the bill
     * makes the operation idempotent.
     */
    inputVatReclassedAt: timestamp('input_vat_reclassed_at', { withTimezone: true }),
    inputVatReclassJournalId: uuid('input_vat_reclass_journal_id'),
    /**
     * 🇹🇭 Set when this bill's input VAT was claimed via a PP.30 closing
     * journal. After close, the §82/3 6-month reclass cron MUST skip this row
     * — the 1155 balance was already credited to 2210 at close.
     */
    pp30FilingId: uuid('pp30_filing_id'),
    /** 3-way match: 'matched' | 'override' | 'unmatched' (computed at post time). */
    matchStatus: text('match_status'),
    matchOverrideBy: text('match_override_by'),
    matchOverrideReason: text('match_override_reason'),
    /** State-transition timestamps. */
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidBy: text('paid_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    internalNumberUnique: uniqueIndex('vendor_bills_internal_number_idx').on(
      table.internalNumber,
    ),
    supplierIdx: index('vendor_bills_supplier_idx').on(table.supplierId),
    poIdx: index('vendor_bills_po_idx').on(table.purchaseOrderId),
    statusIdx: index('vendor_bills_status_idx').on(table.status),
    dateIdx: index('vendor_bills_date_idx').on(table.billDate),
  }),
);

export const vendorBillLines = customSchema.table(
  'vendor_bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vendorBillId: uuid('vendor_bill_id').notNull(),
    lineNo: integer('line_no').notNull(),
    /** Optional — service bills (rent, ad, professional) don't reference a product. */
    productId: uuid('product_id'),
    description: text('description').notNull(),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    /** Net of discount (= qty × unit_price − discount). */
    netCents: bigint('net_cents', { mode: 'number' }).notNull(),
    vatCategory: text('vat_category').notNull().default('standard'), // standard | zero_rated | exempt
    vatMode: text('vat_mode').notNull().default('exclusive'),         // inclusive | exclusive
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    /** WHT category drives the rate (services 3%, rent 5%, ads 2%, freight 1%). */
    whtCategory: text('wht_category'),
    whtRateBp: integer('wht_rate_bp'),  // basis points (300 = 3.00%)
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    /** Expense account override — used for non-product line items. Defaults
     * to 5100 COGS for product lines, 6200 Other operating exp for services. */
    expenseAccountCode: varchar('expense_account_code', { length: 10 }),
    /** 3-way-match references. */
    purchaseOrderLineId: uuid('purchase_order_line_id'),
    goodsReceiptLineId: uuid('goods_receipt_line_id'),
    matchStatus: text('match_status'),  // matched | qty_mismatch | price_mismatch | unmatched
    matchVarianceCents: bigint('match_variance_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    billLineUnique: uniqueIndex('vbl_bill_lineno_idx').on(
      table.vendorBillId,
      table.lineNo,
    ),
    poLineIdx: index('vbl_po_line_idx').on(table.purchaseOrderLineId),
    grnLineIdx: index('vbl_grn_line_idx').on(table.goodsReceiptLineId),
  }),
);

// ─── Bill payments (installments) ──────────────────────────────────────────
/**
 * One row per installment. A vendor bill can be settled in 1..N payments.
 *
 * Per-payment journal:
 *   Dr 2110 AP                    (amountCents — what we are clearing)
 *     Cr 1110/1120 cash           (cashCents = amountCents − whtCents)
 *     Cr 2203 WHT payable         (whtCents — proportional to the installment)
 *
 * WHT split rule (so totals reconcile to bill.whtCents to the satang):
 *   non-final payment: whtCents = floor(amountCents × bill.whtCents / bill.totalCents)
 *   final payment:     whtCents = bill.whtCents − Σ prior whtCents
 *
 * Same trick for cashCents = amountCents − whtCents.
 *
 * 50-Tawi: sum(whtCents) per supplier × month is what shows on the certificate
 * (drives §50ทวิ remittance). Already wired via bill.whtCents in batch 4 — now
 * each installment contributes incrementally so monthly remittance is correct
 * even when bills span months.
 */
export const billPayments = customSchema.table(
  'bill_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vendorBillId: uuid('vendor_bill_id').notNull(),
    /** 1-based running number per bill — used for stable display order. */
    paymentNo: integer('payment_no').notNull(),
    paymentDate: date('payment_date').notNull(),
    /** Amount applied to AP for this installment (gross). */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** WHT recognized on this installment (allocated proportionally + remainder-on-last). */
    whtCents: bigint('wht_cents', { mode: 'number' }).notNull().default(0),
    /** Bank wire / merchant fee we absorb on this payment (Dr 6170). */
    bankChargeCents: bigint('bank_charge_cents', { mode: 'number' }).notNull().default(0),
    /** Cash actually paid out = amount − wht − bank charge. */
    cashCents: bigint('cash_cents', { mode: 'number' }).notNull(),
    /** 1110 cash / 1120 bank — caller picks the channel. */
    cashAccountCode: varchar('cash_account_code', { length: 10 }).notNull().default('1120'),
    paymentMethod: text('payment_method'), // bank_transfer | cheque | cash | promptpay | card
    bankReference: text('bank_reference'),
    /** GL link for this single installment. */
    journalEntryId: uuid('journal_entry_id'),
    paidBy: text('paid_by'),
    notes: text('notes'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    billPaymentNoIdx: uniqueIndex('bill_payments_bill_no_idx').on(
      table.vendorBillId,
      table.paymentNo,
    ),
    billDateIdx: index('bill_payments_bill_date_idx').on(table.vendorBillId, table.paymentDate),
    paymentDateIdx: index('bill_payments_date_idx').on(table.paymentDate),
  }),
);
