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
import { sql } from 'drizzle-orm';
import { customSchema } from './auth';

/**
 * Phase 3 inventory model — hybrid:
 *   - `stock_moves` is the append-only ledger / source-of-truth (audit + RD goods report)
 *   - `stock_quants` caches current qty per (product, warehouse) for O(log n) checkout reads
 *   - `cost_layers` carries FIFO/FEFO + lot/serial/expiry; consumed in age (then expiry) order
 *
 * Design refs (Phase 3 Pre-Phase Research Log, 2026-04-27):
 *   - Odoo stock.move + stock.quant + stock.move.line triad
 *   - ERPNext stock_ledger_entry pattern for backdate reposting
 *   - OCA stock_no_negative for the negative-stock guard
 *   - RD Director-General Notice No. 89 §9 for goods-report column shape
 */

// ─── Warehouses ───────────────────────────────────────────────────────────
export const warehouses = customSchema.table(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 16 }).notNull(), // 'MAIN', 'BR-01', 'KITCHEN'
    name: text('name').notNull(),
    branchCode: varchar('branch_code', { length: 5 }).default('00000'), // Thai branch code if multi-branch
    addressLine: text('address_line'),
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    codeUnique: uniqueIndex('warehouses_code_unique_idx').on(table.code),
    activeIdx: index('warehouses_active_idx').on(table.isActive),
  }),
);

// ─── Stock quants (per-product per-warehouse cache) ───────────────────────
/**
 * One row per (product, warehouse). qty_on_hand is the materialised view of
 * SUM(stock_moves.qty WHERE warehouse_id=…). qty_reserved tracks pending
 * reservations (e.g., a confirmed PO awaiting receipt does NOT reserve, but
 * a partial-pick on the floor does).
 */
export const stockQuants = customSchema.table(
  'stock_quants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    qtyOnHand: numeric('qty_on_hand', { precision: 14, scale: 3 }).notNull().default('0'),
    qtyReserved: numeric('qty_reserved', { precision: 14, scale: 3 }).notNull().default('0'),
    avgCostCents: bigint('avg_cost_cents', { mode: 'number' }), // moving-average cost (Phase 3 batch 2)
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pwUnique: uniqueIndex('stock_quants_pw_unique_idx').on(table.productId, table.warehouseId),
    productIdx: index('stock_quants_product_idx').on(table.productId),
    warehouseIdx: index('stock_quants_warehouse_idx').on(table.warehouseId),
  }),
);

// ─── Stock moves (append-only ledger) ─────────────────────────────────────
/**
 * Every quantity change writes one row here. Conservation invariants:
 *   - move_type='receive'   → qty > 0, to_warehouse set
 *   - move_type='sale'      → qty < 0, from_warehouse set
 *   - move_type='transfer'  → emits 2 rows (-from / +to) in same tx
 *   - move_type='adjust'    → signed; mandatory reason
 *   - move_type='cycle_count_adjust' → tied to cycle_count_session_id
 *   - move_type='damage' / 'expire' → qty < 0, mandatory reason, may reference cost_layer
 *
 * source_module + source_id pattern matches the journal_entries schema; lets
 * Phase 4 accounting attach journal entries via the same shape.
 */
export const stockMoves = customSchema.table(
  'stock_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    moveType: text('move_type').notNull(), // receive | sale | transfer | adjust | cycle_count_adjust | damage | expire | refund
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(), // signed: + receipt, - issue
    fromWarehouseId: uuid('from_warehouse_id'),
    toWarehouseId: uuid('to_warehouse_id'),
    costLayerId: uuid('cost_layer_id'), // which layer this consumed/produced (Phase 3 batch 2)
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }), // cost basis at move time
    sourceModule: text('source_module'), // 'pos' | 'purchase' | 'transfer' | 'manual' | 'cycle_count'
    sourceId: text('source_id'), // FK-loose ref into the source table
    reference: text('reference'), // human-readable doc no (e.g. 'TX2604-000123')
    /** Who performed the move. UUID for real users; string like 'web-pos' or iPad device id otherwise. */
    performedBy: text('performed_by'),
    /** Who approved an override (negative stock, variance > threshold). UUID for real users; 'SYSTEM' for auto. */
    approvedBy: text('approved_by'),
    reason: text('reason'), // mandatory for adjust / damage / expire / cycle_count_adjust
    branchCode: varchar('branch_code', { length: 5 }), // Thai goods-report grouping
    /**
     * Per-layer drawdown breakdown when one move consumes from multiple FIFO/FEFO
     * layers. Shape: [{ layerId, qty, unitCostCents }]. Null when the move maps
     * 1:1 to costLayerId (e.g. simple receipts) or is layer-agnostic (legacy
     * applyMove sales prior to GRN-driven valuation).
     */
    layerConsumption: jsonb('layer_consumption'),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // Idempotency: at-least-once safety. (source_module, source_id, product_id) UNIQUE prevents
    // double-deducting if the OrderCompletedEvent handler retries.
    sourceUnique: uniqueIndex('stock_moves_source_unique_idx')
      .on(table.sourceModule, table.sourceId, table.productId)
      .where(sql`"source_module" IS NOT NULL AND "source_id" IS NOT NULL`),
    productDateIdx: index('stock_moves_product_date_idx').on(table.productId, table.performedAt),
    branchDateIdx: index('stock_moves_branch_date_idx').on(table.branchCode, table.performedAt),
    typeDateIdx: index('stock_moves_type_date_idx').on(table.moveType, table.performedAt),
  }),
);

// ─── Cost layers (FIFO/FEFO + lot/serial/expiry) ──────────────────────────
/**
 * One row per receiving event. FIFO/FEFO consumes oldest layer with
 * qty_remaining > 0 in (expiry_date NULLS LAST, received_at) order.
 *
 * Status enum:
 *   in_stock | reserved | consumed | damaged | expired | quarantine
 *
 * Status transitions logged in stock_moves; layer status is the cached
 * "current" view.
 */
export const costLayers = customSchema.table(
  'cost_layers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    lotCode: text('lot_code'), // batch identifier (food/pharma)
    serialNo: text('serial_no'), // per-unit identity (high-value goods)
    expiryDate: date('expiry_date'),
    removalDate: date('removal_date'), // expiry_date − safety_days; populated by trigger or app
    qtyReceived: numeric('qty_received', { precision: 14, scale: 3 }).notNull(),
    qtyRemaining: numeric('qty_remaining', { precision: 14, scale: 3 }).notNull(),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    status: text('status').notNull().default('in_stock'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    sourceMoveId: uuid('source_move_id'), // back-pointer to the receive stock_move
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // Serial uniqueness per product (across warehouses — moving warehouses doesn't break identity).
    serialUnique: uniqueIndex('cost_layers_serial_unique_idx')
      .on(table.productId, table.serialNo)
      .where(sql`"serial_no" IS NOT NULL`),
    // FEFO query path: qty_remaining > 0 ORDER BY (expiry_date NULLS LAST, received_at)
    fefoIdx: index('cost_layers_fefo_idx').on(
      table.productId,
      table.warehouseId,
      table.expiryDate,
      table.receivedAt,
    ),
    expirySoonIdx: index('cost_layers_expiry_soon_idx').on(table.expiryDate),
    statusIdx: index('cost_layers_status_idx').on(table.status),
  }),
);

// ─── Cycle counts ─────────────────────────────────────────────────────────
export const cycleCountSessions = customSchema.table(
  'cycle_count_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id').notNull(),
    counterUserId: uuid('counter_user_id').notNull(),
    status: text('status').notNull().default('open'), // open | counting | reconciling | posted | cancelled
    blindCountAt: timestamp('blind_count_at', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    varianceTotalCents: bigint('variance_total_cents', { mode: 'number' }), // signed
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    warehouseStatusIdx: index('cycle_count_warehouse_status_idx').on(
      table.warehouseId,
      table.status,
    ),
  }),
);

export const cycleCountLines = customSchema.table(
  'cycle_count_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    productId: uuid('product_id').notNull(),
    expectedQty: numeric('expected_qty', { precision: 14, scale: 3 }).notNull(),
    countedQty: numeric('counted_qty', { precision: 14, scale: 3 }),
    varianceQty: numeric('variance_qty', { precision: 14, scale: 3 }),
    varianceValueCents: bigint('variance_value_cents', { mode: 'number' }),
    autoAccepted: boolean('auto_accepted').notNull().default(false),
    notes: text('notes'),
  },
  (table) => ({
    sessionIdx: index('cycle_count_lines_session_idx').on(table.sessionId),
  }),
);

// ─── Outbox (Odoo write-back, promoted from Phase 4) ──────────────────────
/**
 * Transactional outbox: writes happen in the same DB tx as the source change
 * (POS sale, GRN post, stock adjustment), then a BullMQ relay drains rows to
 * Odoo. external_id is the ir.model.data idempotency key — re-running a job
 * never duplicates because Odoo upserts by xmlid.
 */
export const odooOutbox = customSchema.table(
  'odoo_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    model: text('model').notNull(), // 'stock.move' | 'pos.order' | 'product.template' | …
    operation: text('operation').notNull(), // 'create' | 'write' | 'unlink'
    payload: jsonb('payload').notNull(),
    externalId: text('external_id').notNull(), // 'erp_pos.stock_move_<uuid>'
    status: text('status').notNull().default('pending'), // pending | in_flight | succeeded | failed | dlq
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    odooId: integer('odoo_id'), // populated on success
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    statusNextIdx: index('odoo_outbox_status_next_idx').on(table.status, table.nextAttemptAt),
    externalIdUnique: uniqueIndex('odoo_outbox_external_id_unique_idx').on(table.externalId),
  }),
);

