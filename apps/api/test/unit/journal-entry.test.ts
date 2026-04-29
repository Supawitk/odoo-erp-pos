import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { JournalEntry } from '../../src/modules/accounting/domain/journal-entry';
import { UnbalancedEntryError } from '../../src/modules/accounting/domain/errors';

describe('JournalEntry domain aggregate', () => {
  const someLine = (debitCents = 0, creditCents = 0) => ({
    accountCode: '1110',
    accountName: 'Cash on hand',
    debitCents,
    creditCents,
  });

  it('rejects unbalanced entries', () => {
    expect(() =>
      JournalEntry.create({
        date: '2026-04-29',
        description: 'Unbalanced',
        currency: 'THB',
        lines: [
          { accountCode: '1110', accountName: 'Cash', debitCents: 100, creditCents: 0 },
          { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: 50 },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects entries with fewer than 2 lines', () => {
    expect(() =>
      JournalEntry.create({
        date: '2026-04-29',
        description: 'Single line',
        currency: 'THB',
        lines: [someLine(100, 0)],
      }),
    ).toThrow(/at least two lines/);
  });

  it('rejects lines that are both debit and credit', () => {
    expect(() =>
      JournalEntry.create({
        date: '2026-04-29',
        description: 'Bad line',
        currency: 'THB',
        lines: [
          { accountCode: '1110', accountName: 'Cash', debitCents: 50, creditCents: 50 },
          { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: 0 },
        ],
      }),
    ).toThrow();
  });

  it('rejects negative amounts', () => {
    expect(() =>
      JournalEntry.create({
        date: '2026-04-29',
        description: 'Negative',
        currency: 'THB',
        lines: [
          { accountCode: '1110', accountName: 'Cash', debitCents: -100, creditCents: 0 },
          { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: -100 },
        ],
      }),
    ).toThrow();
  });

  it('rejects zero-amount lines', () => {
    expect(() =>
      JournalEntry.create({
        date: '2026-04-29',
        description: 'Zero',
        currency: 'THB',
        lines: [
          { accountCode: '1110', accountName: 'Cash', debitCents: 0, creditCents: 0 },
          { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: 0 },
        ],
      }),
    ).toThrow();
  });

  it('accepts a balanced two-line entry and snapshots totals', () => {
    const e = JournalEntry.create({
      date: '2026-04-29',
      description: 'Balanced',
      currency: 'THB',
      lines: [
        { accountCode: '1110', accountName: 'Cash', debitCents: 10000, creditCents: 0 },
        { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: 10000 },
      ],
    });
    expect(e.totalDebitCents).toBe(10000);
    expect(e.totalCreditCents).toBe(10000);
  });

  it('property: any entry that constructs has equal debit and credit totals', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: 1, max: 1_000_000 }),
          { minLength: 1, maxLength: 8 },
        ),
        (amounts) => {
          // For every random list of positive cents, build a properly balanced
          // multi-leg entry by mirroring the same amounts on the credit side.
          const lines = [
            ...amounts.map((amt, i) => ({
              accountCode: '1110',
              accountName: `Cash ${i}`,
              debitCents: amt,
              creditCents: 0,
            })),
            ...amounts.map((amt, i) => ({
              accountCode: '4110',
              accountName: `Revenue ${i}`,
              debitCents: 0,
              creditCents: amt,
            })),
          ];
          const e = JournalEntry.create({
            date: '2026-04-29',
            description: 'Property entry',
            currency: 'THB',
            lines,
          });
          expect(e.totalDebitCents).toBe(e.totalCreditCents);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: any random unbalanced split is rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (debitAmt, creditAmt) => {
          // Skip the lucky balanced case
          if (debitAmt === creditAmt) return;
          expect(() =>
            JournalEntry.create({
              date: '2026-04-29',
              description: 'Unbalanced random',
              currency: 'THB',
              lines: [
                { accountCode: '1110', accountName: 'Cash', debitCents: debitAmt, creditCents: 0 },
                { accountCode: '4110', accountName: 'Sales', debitCents: 0, creditCents: creditAmt },
              ],
            }),
          ).toThrow(UnbalancedEntryError);
        },
      ),
      { numRuns: 200 },
    );
  });
});
