import { UnbalancedEntryError } from './errors';

/**
 * A single posting line. `debitCents` and `creditCents` are mutually exclusive
 * — exactly one is non-zero. Money is integer satang (or cents for non-THB).
 *
 * `partnerId` is the optional sub-ledger reference: a customer/supplier id for
 * AR/AP-bearing accounts (1141, 2110), null for everything else.
 */
export interface JournalLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  description?: string;
  partnerId?: string | null;
}

export interface NewJournalEntryInput {
  /** ISO date YYYY-MM-DD — the accounting date, may differ from createdAt. */
  date: string;
  description: string;
  reference?: string | null;
  sourceModule?: string | null;
  sourceId?: string | null;
  currency: string;
  lines: JournalLine[];
}

/**
 * Aggregate that enforces the double-entry invariant: debits ≡ credits.
 *
 * Construction is the point at which the rule is checked; mutation after
 * `create()` is not permitted (use void+offset instead). The DB carries a
 * matching CHECK trigger as a belt-and-suspenders second line of defence.
 */
export class JournalEntry {
  readonly date: string;
  readonly description: string;
  readonly reference: string | null;
  readonly sourceModule: string | null;
  readonly sourceId: string | null;
  readonly currency: string;
  readonly lines: ReadonlyArray<JournalLine>;
  readonly totalDebitCents: number;
  readonly totalCreditCents: number;

  private constructor(input: NewJournalEntryInput, totals: { d: number; c: number }) {
    this.date = input.date;
    this.description = input.description;
    this.reference = input.reference ?? null;
    this.sourceModule = input.sourceModule ?? null;
    this.sourceId = input.sourceId ?? null;
    this.currency = input.currency;
    this.lines = input.lines;
    this.totalDebitCents = totals.d;
    this.totalCreditCents = totals.c;
  }

  /**
   * Validate and build a new journal entry. Throws `UnbalancedEntryError` if
   * the debit/credit totals don't match — caller should never see a draft
   * entry that wouldn't post.
   *
   * Lines with both debit AND credit non-zero are rejected up front (each
   * line has one direction; "swap" requires two lines).
   */
  static create(input: NewJournalEntryInput): JournalEntry {
    if (input.lines.length < 2) {
      throw new Error(
        'Journal entry needs at least two lines (one debit, one credit)',
      );
    }
    let d = 0;
    let c = 0;
    for (const l of input.lines) {
      if (!Number.isInteger(l.debitCents) || !Number.isInteger(l.creditCents)) {
        throw new Error(
          `Line for account ${l.accountCode}: debit/credit must be integer cents`,
        );
      }
      if (l.debitCents < 0 || l.creditCents < 0) {
        throw new Error(
          `Line for account ${l.accountCode}: amounts must be non-negative`,
        );
      }
      if (l.debitCents > 0 && l.creditCents > 0) {
        throw new Error(
          `Line for account ${l.accountCode}: cannot be both debit and credit`,
        );
      }
      if (l.debitCents === 0 && l.creditCents === 0) {
        throw new Error(
          `Line for account ${l.accountCode}: zero-amount lines are not allowed`,
        );
      }
      d += l.debitCents;
      c += l.creditCents;
    }
    if (d !== c) {
      throw new UnbalancedEntryError(d, c);
    }
    return new JournalEntry(input, { d, c });
  }
}
