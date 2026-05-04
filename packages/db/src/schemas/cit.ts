import {
  uuid,
  text,
  varchar,
  bigint,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';
import { journalEntries } from './accounting';

/**
 * CIT (Corporate Income Tax) filings register. One row per (fiscal_year,
 * half_year) — half_year=true is PND.51 (mid-year estimate, due 2 months
 * after H1 ends), half_year=false is PND.50 (annual, due 150 days after
 * fiscal year end).
 *
 * Stores the snapshot at filing time so reprints + audits don't depend on
 * recomputing from the GL (which can drift if backdated entries land later).
 */
export const citFilings = customSchema.table(
  'cit_filings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fiscalYear: integer('fiscal_year').notNull(),
    halfYear: boolean('half_year').notNull().default(false),
    /** Net taxable income (revenue - expenses, after non-deductible adjustments). */
    taxableIncomeCents: bigint('taxable_income_cents', { mode: 'number' }).notNull(),
    /** Tax computed at SME or flat-20% bracket. */
    taxDueCents: bigint('tax_due_cents', { mode: 'number' }).notNull(),
    /** WHT receivable (1157) credits applied. */
    whtCreditsCents: bigint('wht_credits_cents', { mode: 'number' }).notNull().default(0),
    /** PND.51 advance paid (only relevant on PND.50). */
    advancePaidCents: bigint('advance_paid_cents', { mode: 'number' }).notNull().default(0),
    /** Final amount due to RD = tax_due − wht_credits − advance_paid. Can be negative (refund). */
    netPayableCents: bigint('net_payable_cents', { mode: 'number' }).notNull(),
    /** Which bracket applied (sme | flat20) — useful for audit + display. */
    rateBracket: varchar('rate_bracket', { length: 30 }).notNull(),
    filedAt: timestamp('filed_at', { withTimezone: true }).notNull().defaultNow(),
    filedBy: text('filed_by'),
    rdFilingReference: text('rd_filing_reference'),
    notes: text('notes'),
    closingJournalId: uuid('closing_journal_id').references(() => journalEntries.id),
  },
  (t) => [uniqueIndex('cit_year_half_idx').on(t.fiscalYear, t.halfYear)],
);

export type CitFilingRow = typeof citFilings.$inferSelect;
