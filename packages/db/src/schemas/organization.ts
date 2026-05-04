import {
  uuid,
  text,
  boolean,
  timestamp,
  bigint,
  numeric,
  varchar,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';
import { bytea } from './_types';

/**
 * Tenant-level settings. Single-row singleton for the MVP; multi-tenant split
 * is a Phase 6+ concern. `country_mode` is the master switch:
 *   TH      — Thai compliance on: VAT 7%, TIN validation, RE/ABB/TX/CN flow,
 *             PromptPay QR, Thai receipt headers + amount-in-Thai-words,
 *             PP.30 + 50-Tawi reports.
 *   GENERIC — Thai-specific code paths short-circuit. Receipts only (RE). No
 *             TIN capture. No PromptPay. PP.30 endpoints return 404.
 */
export const organizations = customSchema.table('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  countryMode: text('country_mode').notNull().default('TH'), // TH | GENERIC
  vatRegistered: boolean('vat_registered').notNull().default(true),
  currency: varchar('currency', { length: 3 }).notNull().default('THB'),
  locale: text('locale').notNull().default('th-TH'),
  timezone: text('timezone').notNull().default('Asia/Bangkok'),

  // Seller identity — printed on receipts/tax invoices. Nullable when GENERIC
  // and not-yet-configured.
  sellerName: text('seller_name').notNull().default(''),
  sellerTin: text('seller_tin'),
  /** pgcrypto pgp_sym_encrypt(seller_tin, ENCRYPTION_MASTER_KEY) — Phase 1 PII at-rest. */
  sellerTinEncrypted: bytea('seller_tin_encrypted'),
  sellerBranch: text('seller_branch').default('00000'),
  sellerAddress: text('seller_address').default(''),

  // Tax engine
  vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull().default('0.0700'),
  defaultVatMode: text('default_vat_mode').notNull().default('exclusive'), // inclusive | exclusive
  abbreviatedTaxInvoiceCapCents: bigint('abbreviated_tax_invoice_cap_cents', {
    mode: 'number',
  })
    .notNull()
    .default(100000), // ฿1,000

  // Payment / FX
  promptpayBillerId: text('promptpay_biller_id'),
  fxSource: text('fx_source').notNull().default('BOT_MID'),

  /**
   * GL account code charged when bank/card fees are deducted from a customer
   * receipt or vendor payment. Defaults to 6170 (Bank & card fees) per the
   * Thai SME seed; the user can repoint to any expense account they prefer
   * (e.g. 6171 if they want to split card vs wire fees).
   */
  defaultBankChargeAccount: varchar('default_bank_charge_account', {
    length: 10,
  }).notNull().default('6170'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type CountryMode = 'TH' | 'GENERIC';

/**
 * 🇹🇭 Branches — multi-branch model for §86/4 multi-branch tax invoicing.
 *
 * The seller TIN is shared across all branches; each branch gets its own
 * 5-digit `branch_code`. Tax-invoice sequences are partitioned by branch so
 * concurrent branches don't collide ({BR}-TX-YYMM-#####).
 *
 * Default seed: one row with code='00000' (สำนักงานใหญ่ / head office) on
 * first organization-service boot, so single-branch installs Just Work.
 */
export const branches = customSchema.table('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** 5-digit Revenue Department branch code; '00000' = head office (สำนักงานใหญ่). */
  code: varchar('code', { length: 5 }).notNull(),
  name: text('name').notNull(),
  address: text('address'),
  phone: text('phone'),
  isActive: boolean('is_active').notNull().default(true),
  /** True for the head office; exactly one per organization should be true. */
  isHeadOffice: boolean('is_head_office').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
