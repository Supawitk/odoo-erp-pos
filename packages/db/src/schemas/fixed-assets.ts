import {
  uuid,
  text,
  varchar,
  bigint,
  date,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';
import { journalEntries } from './accounting';

/**
 * Fixed assets register. Each row is one depreciable item — a building, a
 * machine, a vehicle, a computer. Land (1510) is conventionally tracked here
 * too but with `useful_life_months = 0` so depreciation is skipped.
 *
 * Depreciation lives in `depreciation_entries` (one row per asset per month
 * with FK to the journal entry) so we have a clear audit trail and can
 * detect/recover from a partial monthly run.
 */
export const fixedAssets = customSchema.table(
  'fixed_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-readable identifier — sequence FA-YYYY-NNNN issued at creation. */
    assetNo: varchar('asset_no', { length: 20 }).notNull().unique(),
    name: text('name').notNull(),
    /**
     * Free-form category — used for grouping in reports + as a UI hint to
     * pre-populate `asset_account_code` (Building/Equipment/Vehicle/Software/Other).
     */
    category: varchar('category', { length: 30 }).notNull().default('equipment'),

    /** When the asset was acquired (PO / invoice date). */
    acquisitionDate: date('acquisition_date').notNull(),
    /** Acquisition cost — includes installation, freight, import duty per IFRS. */
    acquisitionCostCents: bigint('acquisition_cost_cents', { mode: 'number' }).notNull(),
    /** Estimated salvage value at end of useful life (default 0). */
    salvageValueCents: bigint('salvage_value_cents', { mode: 'number' }).notNull().default(0),
    /**
     * Useful life in months. Examples: buildings 240–480 (20–40 yr),
     * equipment 60–120 (5–10 yr), vehicles 60 (5 yr), software 36 (3 yr).
     * Set to 0 for non-depreciable assets like land.
     */
    usefulLifeMonths: integer('useful_life_months').notNull(),

    /** Currently only 'straight_line' is implemented; declining-balance/MACRS later. */
    depreciationMethod: varchar('depreciation_method', { length: 20 })
      .notNull()
      .default('straight_line'),

    /**
     * GL accounts. Defaults match the Thai SME seed but the user can repoint
     * to any valid CoA code (e.g. a different sub-account per asset class).
     */
    assetAccountCode: varchar('asset_account_code', { length: 10 }).notNull(),
    accumulatedDepreciationAccount: varchar('accumulated_depreciation_account', {
      length: 10,
    })
      .notNull()
      .default('1590'),
    expenseAccountCode: varchar('expense_account_code', { length: 10 }).notNull().default('6190'),

    /** First month a depreciation entry should post (typically month after acquisition). */
    depreciationStartDate: date('depreciation_start_date').notNull(),

    /** active | disposed | retired (write-off without sale) */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    /** Filled when status flips to disposed/retired. */
    disposedAt: date('disposed_at'),
    /** Cash received on sale (0 for retire/scrap). */
    disposalProceedsCents: bigint('disposal_proceeds_cents', { mode: 'number' }),
    disposalJournalEntryId: uuid('disposal_journal_entry_id').references(() => journalEntries.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => [
    index('fa_status_idx').on(t.status),
    index('fa_acq_date_idx').on(t.acquisitionDate),
  ],
);

/**
 * One row per (asset, period). The UNIQUE constraint makes
 * `runMonthlyDepreciation` idempotent — running it twice for the same
 * month is a no-op for assets that already have an entry.
 */
export const depreciationEntries = customSchema.table(
  'depreciation_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fixedAssetId: uuid('fixed_asset_id')
      .notNull()
      .references(() => fixedAssets.id, { onDelete: 'cascade' }),
    /** YYYY-MM — the calendar month being depreciated. */
    period: varchar('period', { length: 7 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dep_asset_period_idx').on(t.fixedAssetId, t.period),
    index('dep_period_idx').on(t.period),
  ],
);

export type FixedAssetRow = typeof fixedAssets.$inferSelect;
export type DepreciationEntryRow = typeof depreciationEntries.$inferSelect;
