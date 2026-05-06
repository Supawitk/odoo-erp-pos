import {
  uuid,
  text,
  bigint,
  varchar,
  timestamp,
  jsonb,
  integer,
  index,
  boolean,
  numeric,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customSchema } from './auth';
import { bytea } from './_types';

export const posSessions = customSchema.table('pos_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).notNull(),
  closingBalanceCents: bigint('closing_balance_cents', { mode: 'number' }),
  // Blind close: server computes expected from orders; variance = counted - expected.
  expectedBalanceCents: bigint('expected_balance_cents', { mode: 'number' }),
  varianceCents: bigint('variance_cents', { mode: 'number' }),
  varianceApprovedBy: uuid('variance_approved_by'),
  status: text('status').notNull().default('open'), // open, closing, closed
  deviceId: text('device_id'),
  /** 🇹🇭 §86/4 — branch that issued all documents for this session. Default '00000' = HQ. */
  branchCode: varchar('branch_code', { length: 5 }).notNull().default('00000'),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const products = customSchema.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odooProductId: integer('odoo_product_id').unique(),
    name: text('name').notNull(),
    barcode: text('barcode'),
    sku: text('sku'),
    category: text('category'),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    /** Legacy single-warehouse cache. After Phase 3 migration, primary truth is custom.stock_quants. */
    stockQty: numeric('stock_qty', { precision: 14, scale: 3 }).notNull().default('0'),
    /** Moving-average cost (Phase 3 batch 2 valuation engine). null until first receipt. */
    avgCostCents: bigint('avg_cost_cents', { mode: 'number' }),
    isActive: boolean('is_active').notNull().default(true),
    imageUrl: text('image_url'),
    /** Inventory tracking depth: none (anonymous units), lot (batch tracking), serial (per-unit identity). */
    trackingMode: text('tracking_mode').notNull().default('none'),
    unitOfMeasure: text('unit_of_measure').notNull().default('piece'),
    /** Reorder rule (Phase 3). reorderPoint = threshold below which to alert; reorderQty = suggested order qty. */
    reorderPoint: numeric('reorder_point', { precision: 14, scale: 3 }),
    reorderQty: numeric('reorder_qty', { precision: 14, scale: 3 }),
    leadTimeDays: integer('lead_time_days'),
    // 🇹🇭 Thai VAT attributes (Phase 3 — used at POS + by Phase 4 purchase-side journal posting)
    vatCategory: text('vat_category').notNull().default('standard'), // standard | zero | exempt
    inputVatClaimable: boolean('input_vat_claimable').notNull().default(true),
    inputVatDisallowReason: text('input_vat_disallow_reason'), // entertainment | passenger_car | defective_invoice | non_vat_seller | other
    // 🇹🇭 Excise (Excise Act B.E. 2560) — computed BEFORE VAT
    exciseCategory: text('excise_category'), // alcohol_wine | alcohol_spirits_high | alcohol_spirits_low | tobacco_low | tobacco_high | sugar | null
    exciseSpecificCentsPerUnit: bigint('excise_specific_cents_per_unit', { mode: 'number' }),
    exciseAdValoremBp: integer('excise_ad_valorem_bp'), // basis points: 500 = 5%
    sugarGPer100ml: integer('sugar_g_per_100ml'), // for sugar-tax 6-band lookup
    volumeMl: integer('volume_ml'), // for per-litre excise calc
    abvBp: integer('abv_bp'), // alcohol by volume in basis points (700 = 7.00%)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // Trigram index for fuzzy ILIKE / pg_trgm.similarity() product search.
    // The `gin_trgm_ops` operator class is mandatory — `USING gin (name)`
    // without it fails with "data type text has no default operator class
    // for access method gin". Live DB has the right form (was hand-created);
    // 0001 migration was generated before this op-class was added.
    nameTrgm: index('products_name_trgm_idx').using(
      'gin',
      sql`${table.name} gin_trgm_ops`,
    ),
    barcodeUnique: uniqueIndex('products_barcode_unique_idx').on(table.barcode),
    activeIdx: index('products_active_idx').on(table.isActive, table.name),
    vatCategoryIdx: index('products_vat_category_idx').on(table.vatCategory),
    exciseIdx: index('products_excise_idx').on(table.exciseCategory),
  }),
);

export const posOrders = customSchema.table(
  'pos_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odooOrderId: integer('odoo_order_id'),
    sessionId: uuid('session_id').references(() => posSessions.id),
    customerId: uuid('customer_id'),
    orderLines: jsonb('order_lines').notNull(), // [{productId, name, qty, priceCents, discountCents, vatCategory}]
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    paymentMethod: text('payment_method').notNull(), // cash, card, split, promptpay
    paymentDetails: jsonb('payment_details'),
    status: text('status').notNull().default('draft'), // draft, paid, refunded, voided
    iPadDeviceId: text('ipad_device_id'),
    offlineId: text('offline_id').unique(), // dedup for offline sync
    // 🇹🇭 Thai document metadata
    documentType: text('document_type').notNull().default('RE'), // RE | ABB | TX | CN | DN
    documentNumber: text('document_number'), // assigned from customer_sequences; null for drafts
    buyerName: text('buyer_name'),
    buyerTin: text('buyer_tin'), // 13-digit validated by shared/thai/tin
    /** pgcrypto pgp_sym_encrypt(buyer_tin, ENCRYPTION_MASTER_KEY) — Phase 1 PII at-rest. */
    buyerTinEncrypted: bytea('buyer_tin_encrypted'),
    /** sha256 hex of plaintext buyer_tin — for indexed lookup of repeat buyers. */
    buyerTinHash: text('buyer_tin_hash'),
    buyerBranch: text('buyer_branch'), // 5-digit
    buyerAddress: text('buyer_address'),
    /** pgcrypto pgp_sym_encrypt(buyer_address, ENCRYPTION_MASTER_KEY) — Phase 1 PII at-rest. */
    buyerAddressEncrypted: bytea('buyer_address_encrypted'),
    vatBreakdown: jsonb('vat_breakdown'), // { taxableNetCents, zeroRatedNetCents, exemptNetCents, vatCents, grossCents }
    promptpayRef: text('promptpay_ref'), // Ref1 we put into the QR, echoed back by webhooks
    originalOrderId: uuid('original_order_id'), // for CN/DN: references the TX being amended
    /**
     * 🇹🇭 Set when this sale's output VAT was settled via a PP.30 closing
     * journal. Restatements (PP.30.2) target rows with this set.
     */
    pp30FilingId: uuid('pp30_filing_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    dateIdx: index('pos_orders_date_idx').on(table.createdAt),
    sessionIdx: index('pos_orders_session_idx').on(table.sessionId, table.status),
    offlineIdx: index('pos_orders_offline_idx').on(table.offlineId),
    docNumIdx: index('pos_orders_doc_num_idx').on(table.documentType, table.documentNumber),
    buyerTinHashIdx: index('pos_orders_buyer_tin_hash_idx').on(table.buyerTinHash),
  }),
);

/**
 * 🇹🇭 Document sequence counters per (document_type, period_yyyymm).
 * Gapless monotonic — Revenue Code §86 requires no gaps; we reserve the
 * number in a transaction and commit on successful post, voiding on failure
 * so the sequence never loses a slot. Sequence is "soft" (a row's
 * `next_number` is incremented by `UPDATE ... RETURNING next_number` under a
 * row lock) because PostgreSQL `SEQUENCE` gaps on rollback.
 */
/**
 * Held carts — paused checkouts the cashier can recall later. Different from
 * `pos_orders` because nothing has been committed yet: no document number, no
 * journal entry, no stock decrement. Just a labeled snapshot of the cart.
 *
 * Lifecycle: Hold → Recall → DELETE; or Hold → Cancel → DELETE.
 */
export const heldCarts = customSchema.table(
  'held_carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').references(() => posSessions.id, {
      onDelete: 'cascade',
    }),
    label: text('label').notNull(),
    cartLines: jsonb('cart_lines').notNull(),
    buyer: jsonb('buyer'),
    cartDiscountCents: bigint('cart_discount_cents', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index('held_carts_session_idx').on(table.sessionId, table.createdAt),
  }),
);

export const documentSequences = customSchema.table(
  'document_sequences',
  {
    documentType: text('document_type').notNull(), // RE | ABB | TX | CN | DN | PO | GRN | VB | SI
    period: varchar('period', { length: 6 }).notNull(), // YYYYMM
    /**
     * 🇹🇭 §86/4 multi-branch sequence partition. Default '00000' = head office.
     * Format when non-default: `{BR}-{TYPE}{YYMM}-#####` (e.g. 00099-TX2605-000001).
     * Default branch keeps the legacy `{TYPE}{YYMM}-#####` format so existing
     * single-branch deployments don't see a number-format change.
     */
    branchCode: varchar('branch_code', { length: 5 }).notNull().default('00000'),
    nextNumber: integer('next_number').notNull().default(1),
    prefix: text('prefix').notNull(), // e.g. "TX2604" → final = TX2604-000123
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex('document_sequences_pk').on(
      table.documentType,
      table.period,
      table.branchCode,
    ),
  }),
);

/**
 * 🇹🇭 PP.30 monthly VAT closing — one row per filed period.
 *
 * The "close" posts a single journal:
 *   Dr 2201 Output VAT     (period gross output VAT, net of CN/DN)
 *     Cr 1155 Input VAT    (period claimed input VAT, excl. expired+reclassed)
 *     Cr 2210 VAT payable  (when output > input — net amount due to RD)
 *   OR
 *   Dr 1158 VAT refund     (when input > output — refund-due-from-RD)
 *
 * Every contributing pos_order + vendor_bill is stamped with `pp30_filing_id`
 * so future runs (and the §82/3 reclass cron) know they've been settled.
 *
 * One ACTIVE filing per (year, month) — UNIQUE partial index. An amendment
 * (PP.30.2 territory) sets the existing row to status='amended' and inserts
 * a new 'filed' row.
 */
export const pp30Filings = customSchema.table(
  'pp30_filings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    /** Output VAT moved out of 2201, net of CN/DN. */
    outputVatCents: bigint('output_vat_cents', { mode: 'number' }).notNull(),
    /** Input VAT moved out of 1155 — only bills posted in or before the period
     *  AND not yet reclassed AND not yet pp30-claimed. */
    inputVatCents: bigint('input_vat_cents', { mode: 'number' }).notNull(),
    /** Positive: payable to RD (Cr 2210). Negative: refund due (Dr 1158). */
    netPayableCents: bigint('net_payable_cents', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('filed'), // filed | amended
    closingJournalId: uuid('closing_journal_id'),
    filedAt: timestamp('filed_at', { withTimezone: true }).notNull().defaultNow(),
    filedBy: uuid('filed_by'),
    rdFilingReference: text('rd_filing_reference'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    filedAtIdx: index('pp30_filings_filed_at_idx').on(table.filedAt),
  }),
);
