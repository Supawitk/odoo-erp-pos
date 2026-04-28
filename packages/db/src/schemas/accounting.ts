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
  name: text('name').notNull(),
  type: text('type').notNull(), // asset, liability, equity, revenue, expense
  parentCode: varchar('parent_code', { length: 10 }),
  isActive: boolean('is_active').notNull().default(true),
  normalBalance: text('normal_balance').notNull(), // debit or credit
});

export const journalEntries = customSchema.table(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryNumber: serial('entry_number'),
    date: date('date').notNull(),
    description: text('description').notNull(),
    reference: text('reference'), // POS order ID, invoice number
    sourceModule: text('source_module'), // pos, invoicing, manual
    sourceId: text('source_id'),
    status: text('status').notNull().default('draft'), // draft, posted, voided
    voidedById: uuid('voided_by_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    dateIdx: index('journal_entries_date_idx').on(table.date),
    statusIdx: index('journal_entries_status_idx').on(table.status),
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
