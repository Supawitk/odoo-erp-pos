import { describe, it, expect } from 'vitest';
import { computeExcise, sugarBand } from './excise';

describe('Thai excise calculator', () => {
  describe('sugar drinks (Phase 4 final, 1 Apr 2026)', () => {
    it.each([
      [4, 0, 'sugar_band_exempt'], // ≤6 g/100ml = exempt
      [6, 0, 'sugar_band_exempt'],
      [7, 100, null], // 6–8 → ฿1/L
      [8, 100, null],
      [9, 300, null], // 8–10 → ฿3/L
      [10, 300, null],
      [12, 500, null], // 10–14 → ฿5/L
      [16, 500, null], // 14–18 → ฿5/L
      [25, 500, null], // ≥18 → ฿5/L
    ])('sugar %i g/100ml → %i satang/L', (g, expectedRate, expectedReason) => {
      const r = computeExcise({
        product: {
          category: 'sugar',
          sugarGPer100ml: g,
          volumeMl: 1000, // exactly 1L → specific = expectedRate * 1
        },
        qty: 1,
        unitPriceCents: 2500,
      });
      expect(r.specificCents).toBe(expectedRate);
      expect(r.reason).toBe(expectedReason);
      expect(r.adValoremCents).toBe(0); // sugar has 0% ad valorem
    });

    it('sugar band lookup is monotonic non-decreasing', () => {
      let last = 0;
      for (const g of [0, 5, 6, 7, 8, 9, 10, 12, 14, 18, 100]) {
        const r = sugarBand(g).centsPerLitre;
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
    });
  });

  describe('alcohol', () => {
    it('wine — 750 ml at 12% ABV, 1 bottle → ฿90 specific (1000 ฿/L pure alcohol × 0.09 L)', () => {
      const r = computeExcise({
        product: {
          category: 'alcohol_wine',
          volumeMl: 750,
          abvBp: 1200, // 12.00%
        },
        qty: 1,
        unitPriceCents: 50000, // ฿500
      });
      // Pure alcohol litres = 1 × 750/1000 × 1200/10000 = 0.09 L
      // Specific = 0.09 × 100,000 satang/L = 9,000 satang = ฿90
      expect(r.specificCents).toBe(9000);
      // Ad valorem 5% of ฿500 = ฿25 = 2,500 satang
      expect(r.adValoremCents).toBe(2500);
      expect(r.exciseCents).toBe(11500);
    });

    it('spirits >7% ABV — 700 ml at 40% ABV → specific = 0.28 L × ฿255 = ฿71.40', () => {
      const r = computeExcise({
        product: { category: 'alcohol_spirits_high', volumeMl: 700, abvBp: 4000 },
        qty: 1,
        unitPriceCents: 100000, // ฿1,000
      });
      expect(r.specificCents).toBe(7140); // 0.28L × 25,500 satang/L
      expect(r.adValoremCents).toBe(10000); // 10% of ฿1,000
      expect(r.exciseCents).toBe(17140);
    });

    it('traditional ≤7% ABV — no ad valorem', () => {
      const r = computeExcise({
        product: { category: 'alcohol_spirits_low', volumeMl: 600, abvBp: 600 },
        qty: 1,
        unitPriceCents: 30000,
      });
      expect(r.adValoremCents).toBe(0);
    });
  });

  describe('tobacco', () => {
    it('cheap pack (≤฿72) — 20 sticks × ฿1.25 + 25% × ฿65 → 25 + 16.25 = ฿41.25', () => {
      const r = computeExcise({
        product: { category: 'tobacco_low' },
        qty: 20, // sticks
        unitPriceCents: 325, // ฿3.25/stick → pack of 20 = ฿65
      });
      expect(r.specificCents).toBe(2500); // 20 × 125
      expect(r.adValoremCents).toBe(1625); // 25% × 20 × 325 = 1625
      expect(r.exciseCents).toBe(4125);
    });

    it('premium pack (>฿72) — 42% ad valorem', () => {
      const r = computeExcise({
        product: { category: 'tobacco_high' },
        qty: 20,
        unitPriceCents: 500, // ฿5/stick → ฿100 pack
      });
      expect(r.specificCents).toBe(2500);
      expect(r.adValoremCents).toBe(4200); // 42% × 20 × 500 = 4200
    });
  });

  describe('non-excise products', () => {
    it('returns 0 with reason="no_category"', () => {
      const r = computeExcise({
        product: { category: null },
        qty: 5,
        unitPriceCents: 1000,
      });
      expect(r.exciseCents).toBe(0);
      expect(r.reason).toBe('no_category');
    });
  });

  describe('overrides', () => {
    it('exciseSpecificCentsPerUnit override beats default rate (alcohol)', () => {
      const r = computeExcise({
        product: {
          category: 'alcohol_wine',
          exciseSpecificCentsPerUnit: 50000, // half default
          volumeMl: 1000,
          abvBp: 1000,
        },
        qty: 1,
        unitPriceCents: 0,
      });
      // Pure alcohol L = 1 × 1 × 0.1 = 0.1 L → 0.1 × 50,000 = 5,000
      expect(r.specificCents).toBe(5000);
    });

    it('exciseAdValoremBp override applies', () => {
      const r = computeExcise({
        product: { category: 'tobacco_low', exciseAdValoremBp: 0 },
        qty: 20,
        unitPriceCents: 100,
      });
      expect(r.adValoremCents).toBe(0);
    });
  });
});
