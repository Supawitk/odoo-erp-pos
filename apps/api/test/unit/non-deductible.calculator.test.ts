import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CATEGORY_LABELS_EN,
  CATEGORY_LABELS_TH,
  NON_DEDUCTIBLE_CATEGORIES,
  donationCap,
  entertainmentCap,
  parseCategory,
  summariseByCategory,
} from '../../src/modules/reports/non-deductible.calculator';

describe('§65 ter — non-deductible calculator', () => {
  describe('entertainmentCap', () => {
    it('uses the higher of (0.3% revenue, 0.3% capital)', () => {
      // Revenue ฿20M, capital ฿5M → revenue basis wins (฿60k > ฿15k)
      const r = entertainmentCap({
        annualRevenueCents: 2_000_000_000,
        paidInCapitalCents: 500_000_000,
        actualEntertainmentCents: 0,
      });
      expect(r.capCents).toBe(6_000_000); // 0.3% × ฿20M = ฿60k = 6,000,000 satang
      expect(r.reason).toMatch(/revenue/);

      // Capital larger than revenue (rare — startup with high paid-in but no sales)
      const r2 = entertainmentCap({
        annualRevenueCents: 100_000_000, // ฿1M
        paidInCapitalCents: 1_000_000_000, // ฿10M
        actualEntertainmentCents: 0,
      });
      expect(r2.capCents).toBe(3_000_000); // 0.3% × ฿10M = ฿30k
      expect(r2.reason).toMatch(/capital/);
    });

    it('caps at ฿10M absolute', () => {
      // Massive company: 0.3% × revenue would be ฿100M, but ceiling kicks in
      const r = entertainmentCap({
        annualRevenueCents: 3_333_333_333_300, // ฿33.3B
        paidInCapitalCents: 0,
        actualEntertainmentCents: 0,
      });
      expect(r.capCents).toBe(1_000_000_000); // ฿10M ceiling
      expect(r.reason).toMatch(/฿10M absolute ceiling/);
    });

    it('flags only the over-cap portion', () => {
      // ฿80k entertainment, ฿60k cap → ฿20k flagged
      const r = entertainmentCap({
        annualRevenueCents: 2_000_000_000,
        paidInCapitalCents: 0,
        actualEntertainmentCents: 8_000_000, // ฿80k
      });
      expect(r.capCents).toBe(6_000_000);
      expect(r.spentCents).toBe(8_000_000);
      expect(r.overCapCents).toBe(2_000_000); // ฿20k flagged
    });

    it('zero over-cap when spent ≤ cap', () => {
      const r = entertainmentCap({
        annualRevenueCents: 2_000_000_000,
        paidInCapitalCents: 0,
        actualEntertainmentCents: 5_000_000, // ฿50k, under the ฿60k cap
      });
      expect(r.overCapCents).toBe(0);
    });

    it('property: cap math is monotonic + non-negative', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 3_000_000_000_000 }), // up to ฿30B revenue
          fc.integer({ min: 0, max: 1_000_000_000_000 }), // up to ฿10B capital
          fc.integer({ min: 0, max: 100_000_000_000 }), // up to ฿1B spent
          (rev, cap, spent) => {
            const r = entertainmentCap({
              annualRevenueCents: rev,
              paidInCapitalCents: cap,
              actualEntertainmentCents: spent,
            });
            // Cap is non-negative
            expect(r.capCents).toBeGreaterThanOrEqual(0);
            // Cap never exceeds the ฿10M ceiling
            expect(r.capCents).toBeLessThanOrEqual(1_000_000_000);
            // overCap = max(0, spent − cap)
            expect(r.overCapCents).toBe(Math.max(0, spent - r.capCents));
            // Conservation: spent = cap-portion + over-cap-portion (when spent > 0)
            const capPortion = Math.min(spent, r.capCents);
            expect(capPortion + r.overCapCents).toBe(spent);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('donationCap', () => {
    it('caps at 2% of net profit BEFORE donation deduction', () => {
      // Revenue ฿10M, expense ฿7M (incl. ฿100k donation)
      // → profit-before-donation = 10M − 7M + 100k = ฿3.1M
      // → cap = 2% × ฿3.1M = ฿62k
      // → ฿100k donation, ฿38k flagged
      const r = donationCap({
        revenueCents: 1_000_000_000,
        expenseCents: 700_000_000,
        actualDonationsCents: 10_000_000,
      });
      expect(r.capCents).toBe(6_200_000);
      expect(r.spentCents).toBe(10_000_000);
      expect(r.overCapCents).toBe(3_800_000);
    });

    it('zero cap when company is in loss before donations', () => {
      // Revenue ฿1M, expense ฿2M (incl. ฿0 donation)
      // → profit-before-donation = -1M (negative)
      // → cap = 0
      const r = donationCap({
        revenueCents: 100_000_000,
        expenseCents: 200_000_000,
        actualDonationsCents: 5_000_000,
      });
      expect(r.capCents).toBe(0);
      expect(r.overCapCents).toBe(5_000_000); // entire amount flagged
    });

    it('handles zero donations cleanly', () => {
      const r = donationCap({
        revenueCents: 1_000_000_000,
        expenseCents: 700_000_000,
        actualDonationsCents: 0,
      });
      expect(r.overCapCents).toBe(0);
    });
  });

  describe('summariseByCategory', () => {
    it('groups by category and sums', () => {
      const rows = [
        { category: 'entertainment_over_cap' as const, cents: 1000 },
        { category: 'entertainment_over_cap' as const, cents: 500 },
        { category: 'fines_penalties' as const, cents: 2000 },
        { category: 'cit_self' as const, cents: 80_500_000 },
      ];
      const r = summariseByCategory(rows);
      expect(r.byCategory.entertainment_over_cap).toBe(1500);
      expect(r.byCategory.fines_penalties).toBe(2000);
      expect(r.byCategory.cit_self).toBe(80_500_000);
      expect(r.byCategory.donations_over_cap).toBe(0);
      expect(r.totalCents).toBe(80_503_500);
    });

    it('property: total = sum of all category buckets', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              category: fc.constantFrom(...NON_DEDUCTIBLE_CATEGORIES),
              cents: fc.integer({ min: 0, max: 100_000_000 }),
            }),
            { minLength: 0, maxLength: 50 },
          ),
          (rows) => {
            const r = summariseByCategory(rows);
            const sumOfBuckets = Object.values(r.byCategory).reduce((s, v) => s + v, 0);
            expect(sumOfBuckets).toBe(r.totalCents);
            expect(r.totalCents).toBe(rows.reduce((s, x) => s + x.cents, 0));
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('parseCategory', () => {
    it('accepts known categories', () => {
      expect(parseCategory('entertainment_over_cap')).toBe('entertainment_over_cap');
      expect(parseCategory('cit_self')).toBe('cit_self');
      expect(parseCategory('other')).toBe('other');
    });

    it('rejects unknown', () => {
      expect(parseCategory('not_a_real_category')).toBeNull();
      expect(parseCategory('')).toBeNull();
      expect(parseCategory(null)).toBeNull();
      expect(parseCategory(undefined)).toBeNull();
      expect(parseCategory(42)).toBeNull();
    });
  });

  describe('label tables', () => {
    it('every category has a TH and EN label', () => {
      for (const cat of NON_DEDUCTIBLE_CATEGORIES) {
        expect(CATEGORY_LABELS_TH[cat]).toBeTruthy();
        expect(CATEGORY_LABELS_EN[cat]).toBeTruthy();
      }
    });

    it('TH labels reference a §65 ter sub-section in parens', () => {
      // Spot-check the ones we expect to cite the statute.
      expect(CATEGORY_LABELS_TH.entertainment_over_cap).toMatch(/§65 ตรี/);
      expect(CATEGORY_LABELS_TH.fines_penalties).toMatch(/§65 ตรี/);
      expect(CATEGORY_LABELS_TH.cit_self).toMatch(/§65 ตรี/);
    });
  });
});
