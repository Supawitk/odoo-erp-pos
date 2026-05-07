import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeSurcharge } from '../../src/modules/reports/pp30-surcharge';

describe('PP.30 §27 surcharge calculator', () => {
  it('returns zero when refund-direction (additional VAT < 0)', () => {
    const r = computeSurcharge({
      additionalVatPayableCents: -50000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2027, 0, 15)),
    });
    expect(r.surchargeCents).toBe(0);
    expect(r.surchargeMonths).toBe(0);
    expect(r.cappedAt200pct).toBe(false);
  });

  it('returns zero when delta is exactly zero', () => {
    const r = computeSurcharge({
      additionalVatPayableCents: 0,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2027, 5, 30)),
    });
    expect(r.surchargeCents).toBe(0);
    expect(r.surchargeMonths).toBe(0);
  });

  it('returns zero when filed before the original due date', () => {
    // April 2026 → due 2026-05-15. Amend on 2026-05-10 = before due.
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000, // ฿1,000
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2026, 4, 10)),
    });
    expect(r.surchargeCents).toBe(0);
    expect(r.surchargeMonths).toBe(0);
    expect(r.originalDueDate).toBe('2026-05-15');
  });

  it('returns zero when filed exactly on the due date', () => {
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2026, 4, 15)),
    });
    expect(r.surchargeCents).toBe(0);
    expect(r.surchargeMonths).toBe(0);
  });

  it('charges 1 month when filed one day after due date', () => {
    // April 2026 → due 2026-05-15. Amend 2026-05-16 = 1 day late = 1 month.
    // Surcharge = 100,000 × 1.5% × 1 = 1,500 satang (฿15).
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2026, 4, 16)),
    });
    expect(r.surchargeMonths).toBe(1);
    expect(r.surchargeCents).toBe(1500);
    expect(r.cappedAt200pct).toBe(false);
  });

  it('charges 1 month when filed exactly one calendar month after due date', () => {
    // April 2026 due 2026-05-15. Amend 2026-06-15 = exactly 1 month = 1 month.
    const r = computeSurcharge({
      additionalVatPayableCents: 200_000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2026, 5, 15)),
    });
    expect(r.surchargeMonths).toBe(1);
    expect(r.surchargeCents).toBe(3000);
  });

  it('charges 2 months when filed one month + one day after due date', () => {
    // April 2026 due 2026-05-15. Amend 2026-06-16 = 1 month + 1 day = 2 months.
    const r = computeSurcharge({
      additionalVatPayableCents: 200_000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2026, 5, 16)),
    });
    expect(r.surchargeMonths).toBe(2);
    expect(r.surchargeCents).toBe(6000);
  });

  it('charges 12 months for exactly 1 year delay', () => {
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000,
      periodYear: 2026,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2027, 4, 15)),
    });
    expect(r.surchargeMonths).toBe(12);
    expect(r.surchargeCents).toBe(18000); // 1.5% × 12 × 100,000 = 18,000 satang
  });

  it('caps at 200% of the additional VAT (§27 paragraph 4)', () => {
    // 100,000 × 1.5% × 200 months = 300,000 satang RAW
    // Cap = 100,000 × 2 = 200,000 satang. Cap kicks in.
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000,
      periodYear: 2010,
      periodMonth: 4,
      amendmentDate: new Date(Date.UTC(2030, 0, 1)), // ~17 years later, well past cap
    });
    expect(r.cappedAt200pct).toBe(true);
    expect(r.surchargeCents).toBe(200_000);
  });

  it('handles December → January year rollover for due date', () => {
    // December 2026 → due 2027-01-15.
    const r = computeSurcharge({
      additionalVatPayableCents: 100_000,
      periodYear: 2026,
      periodMonth: 12,
      amendmentDate: new Date(Date.UTC(2027, 0, 16)),
    });
    expect(r.originalDueDate).toBe('2027-01-15');
    expect(r.surchargeMonths).toBe(1);
    expect(r.surchargeCents).toBe(1500);
  });

  it('rejects invalid period year/month', () => {
    expect(() =>
      computeSurcharge({
        additionalVatPayableCents: 100,
        periodYear: 1999,
        periodMonth: 4,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSurcharge({
        additionalVatPayableCents: 100,
        periodYear: 2026,
        periodMonth: 13,
      }),
    ).toThrow(RangeError);
  });

  describe('property tests', () => {
    it('surcharge is non-negative for any input', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -10_000_000, max: 10_000_000 }),
          fc.integer({ min: 2000, max: 9999 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 0, max: 100 * 365 }), // days from due date
          (additional, year, month, daysAfterDue) => {
            const dueY = month === 12 ? year + 1 : year;
            const dueM = month === 12 ? 1 : month + 1;
            const due = new Date(Date.UTC(dueY, dueM - 1, 15));
            const amendmentDate = new Date(due.getTime() + daysAfterDue * 86400_000);
            const r = computeSurcharge({
              additionalVatPayableCents: additional,
              periodYear: year,
              periodMonth: month,
              amendmentDate,
            });
            expect(r.surchargeCents).toBeGreaterThanOrEqual(0);
            expect(r.surchargeMonths).toBeGreaterThanOrEqual(0);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('surcharge never exceeds 200% of additional VAT', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000_000 }),
          fc.integer({ min: 2000, max: 2050 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 0, max: 50 * 365 }),
          (additional, year, month, daysAfterDue) => {
            const dueY = month === 12 ? year + 1 : year;
            const dueM = month === 12 ? 1 : month + 1;
            const due = new Date(Date.UTC(dueY, dueM - 1, 15));
            const amendmentDate = new Date(due.getTime() + daysAfterDue * 86400_000);
            const r = computeSurcharge({
              additionalVatPayableCents: additional,
              periodYear: year,
              periodMonth: month,
              amendmentDate,
            });
            expect(r.surchargeCents).toBeLessThanOrEqual(additional * 2);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('refund deltas always produce zero surcharge', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1_000_000_000, max: 0 }),
          fc.integer({ min: 2000, max: 2050 }),
          fc.integer({ min: 1, max: 12 }),
          (additional, year, month) => {
            const r = computeSurcharge({
              additionalVatPayableCents: additional,
              periodYear: year,
              periodMonth: month,
              amendmentDate: new Date(Date.UTC(2030, 0, 1)),
            });
            expect(r.surchargeCents).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
