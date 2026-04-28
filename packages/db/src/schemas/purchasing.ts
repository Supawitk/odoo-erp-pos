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
    /** 13-digit Thai TIN; mod-11 validated by @erp/shared/thai/tin. */
    tin: varchar('tin', { length: 13 }),
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
