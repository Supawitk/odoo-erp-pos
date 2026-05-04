import {
  uuid,
  text,
  bigint,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  integer,
  date,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';

/**
 * Bank reconciliation — imported bank statements + matching against journal
 * entries that touched the same cash account.
 *
 * Workflow:
 *   1. Import OFX or CSV file → one `bank_statements` header + N `bank_statement_lines`.
 *   2. Auto-suggest matches: for each unmatched bank line, find candidate JE
 *      lines on the same cash account with the same amount within a date
 *      window (configurable, default ±3 days). Score by exact-amount,
 *      reference-text similarity, and date proximity.
 *   3. User confirms a match → write to `bank_match_links` (one row per JE
 *      mapped to the bank line). Bank line status flips to 'matched'.
 *   4. Unmatched-bank-side rows = bank movement we haven't booked yet.
 *      Unmatched-GL-side cash lines = JE we have no bank evidence for.
 *
 * Why a separate `bank_match_links` table (not just FKs on bank_statement_lines):
 *   one bank deposit can represent multiple same-day customer receipts
 *   wired together. So bank line → many JE links.
 */
export const bankStatements = customSchema.table(
  'bank_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cashAccountCode: varchar('cash_account_code', { length: 10 }).notNull(),
    bankLabel: text('bank_label').notNull(),
    statementFrom: date('statement_from'),
    statementTo: date('statement_to'),
    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }),
    closingBalanceCents: bigint('closing_balance_cents', { mode: 'number' }),
    /** SHA-256 of raw file bytes — collision = duplicate import (409). */
    fileHash: text('file_hash').notNull(),
    source: text('source').notNull(), // ofx | csv | manual
    filename: text('filename'),
    importedBy: text('imported_by'),
    importedAt: timestamp('imported_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    fileHashUnique: uniqueIndex('bank_statements_file_hash_idx').on(table.fileHash),
    accountIdx: index('bank_statements_account_idx').on(
      table.cashAccountCode,
      table.statementFrom,
    ),
  }),
);

export const bankStatementLines = customSchema.table(
  'bank_statement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statementId: uuid('statement_id').notNull(),
    lineNo: integer('line_no').notNull(),
    postedAt: date('posted_at').notNull(),
    /** Signed in BANK perspective: positive = inflow to our account. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text('description'),
    /** Bank's own reference / FITID. Used as part of the dedup fingerprint. */
    bankRef: text('bank_ref'),
    /** sha256(posted_at|amount_cents|bank_ref||description). Same line
     * re-imported in a new file → match by fingerprint, not insert. */
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('unmatched'), // unmatched | matched | ignored
    journalEntryId: uuid('journal_entry_id'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    matchedBy: text('matched_by'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fingerprintUnique: uniqueIndex('bsl_fingerprint_idx').on(table.fingerprint),
    statementIdx: index('bsl_statement_idx').on(table.statementId, table.lineNo),
    statusIdx: index('bsl_status_idx').on(table.status),
    postedIdx: index('bsl_posted_idx').on(table.postedAt),
  }),
);

export const bankMatchLinks = customSchema.table(
  'bank_match_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankLineId: uuid('bank_line_id').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    sourceModule: text('source_module'),
    sourceId: text('source_id'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    matchedBy: text('matched_by'),
    matchedAt: timestamp('matched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    bankIdx: index('bml_bank_idx').on(table.bankLineId),
    journalIdx: index('bml_journal_idx').on(table.journalEntryId),
    /** A given JE can only be matched once across all bank statements. */
    journalUnique: uniqueIndex('bml_journal_unique_idx').on(table.journalEntryId),
  }),
);
