import {
  uuid,
  text,
  bigint,
  varchar,
  date,
  timestamp,
  boolean,
  serial,
  index,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';

export const chartOfAccounts = customSchema.table('chart_of_accounts', {
  code: varchar('code', { length: 10 }).primaryKey(),
  // Canonical display name (whatever the org prefers — typically Thai or English)
  name: text('name').notNull(),
  // Optional bilingual labels — let UI pick which to render based on countryMode
  nameTh: text('name_th'),
  nameEn: text('name_en'),
  type: text('type').notNull(), // asset, liability, equity, revenue, expense
  parentCode: varchar('parent_code', { length: 10 }),
  isActive: boolean('is_active').notNull().default(true),
  normalBalance: text('normal_balance').notNull(), // debit or credit
  /**
   * True for any account that should appear in cash-account dropdowns
   * (POS receipts, AP/AR payments, bank reconciliation) and in the Cash
   * Flow Statement's cash + cash-equivalents line. Seeded true for
   * 1110 cash on hand / 1120 bank checking / 1130 bank savings; the user
   * can flip it on for any new bank account they create.
   */
  isCashAccount: boolean('is_cash_account').notNull().default(false),
});

export const journalEntries = customSchema.table(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryNumber: serial('entry_number'),
    date: date('date').notNull(),
    description: text('description').notNull(),
    reference: text('reference'), // POS order ID, invoice number
    sourceModule: text('source_module'), // pos, invoicing, manual, refund
    sourceId: text('source_id'),
    /** ISO 4217. THB by default — multi-currency journals revaluation is
     * Phase 5 work; for now every line in an entry shares one currency. */
    currency: varchar('currency', { length: 3 }).notNull().default('THB'),
    /** Denormalised totals — kept in sync by the database trigger so reports
     * don't have to re-aggregate the lines table on every read. */
    totalDebitCents: bigint('total_debit_cents', { mode: 'number' }).notNull().default(0),
    totalCreditCents: bigint('total_credit_cents', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('draft'), // draft, posted, voided
    voidedById: uuid('voided_by_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    dateIdx: index('journal_entries_date_idx').on(table.date),
    statusIdx: index('journal_entries_status_idx').on(table.status),
    sourceIdx: index('journal_entries_source_idx').on(table.sourceModule, table.sourceId),
  }),
);

export const journalEntryLines = customSchema.table(
  'journal_entry_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    accountCode: varchar('account_code', { length: 10 }).notNull(),
    accountName: text('account_name').notNull(),
    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    description: text('description'),
    partnerId: text('partner_id'),
  },
  (table) => ({
    entryIdx: index('jel_entry_idx').on(table.journalEntryId),
    accountIdx: index('jel_account_idx').on(table.accountCode),
  }),
);
