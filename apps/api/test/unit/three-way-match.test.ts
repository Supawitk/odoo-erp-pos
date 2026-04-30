import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  classifyLineMatch,
  rollupBillMatch,
} from '../../src/modules/purchasing/domain/three-way-match';
import {
  computeWhtCents,
  whtRateBp,
} from '../../src/modules/purchasing/domain/wht';

describe('Three-way match', () => {
  it('matched when qty + price both line up', () => {
    const r = classifyLineMatch({
      qty: 10,
      unitPriceCents: 5000,
      poUnitPriceCents: 5000,
      grnQtyAccepted: 10,
    });
    expect(r.status).toBe('matched');
  });

  it('qty_mismatch when bill exceeds GRN accepted', () => {
    const r = classifyLineMatch({
      qty: 12,
      unitPriceCents: 5000,
      poUnitPriceCents: 5000,
      grnQtyAccepted: 10,
    });
    expect(r.status).toBe('qty_mismatch');
    expect(r.qtyVariance).toBe(2);
  });

  it('price_mismatch when bill exceeds PO price by more than tolerance', () => {
    // 1% tolerance default: PO=5000, allowed delta = 50. We charge 5100 → 100 > 50 → mismatch.
    const r = classifyLineMatch({
      qty: 10,
      unitPriceCents: 5100,
      poUnitPriceCents: 5000,
      grnQtyAccepted: 10,
    });
    expect(r.status).toBe('price_mismatch');
    expect(r.priceVarianceCents).toBe(100);
  });

  it('matched when price variance is within tolerance', () => {
    const r = classifyLineMatch({
      qty: 10,
      unitPriceCents: 5040,
      poUnitPriceCents: 5000,
      grnQtyAccepted: 10,
    });
    expect(r.status).toBe('matched');
  });

  it('unmatched when neither PO nor GRN reference (service bill)', () => {
    const r = classifyLineMatch({ qty: 1, unitPriceCents: 100000 });
    expect(r.status).toBe('unmatched');
  });

  it('rollupBillMatch flags any mismatch as unmatched', () => {
    expect(
      rollupBillMatch([
        { status: 'matched', qtyVariance: 0, priceVarianceCents: 0 },
        { status: 'qty_mismatch', qtyVariance: 5, priceVarianceCents: 0 },
      ]),
    ).toBe('unmatched');
    expect(
      rollupBillMatch([
        { status: 'matched', qtyVariance: 0, priceVarianceCents: 0 },
        { status: 'matched', qtyVariance: 0, priceVarianceCents: 0 },
      ]),
    ).toBe('matched');
    // unmatched (no refs) does NOT trip the bill-level rollup — that's
    // reserved for actual qty/price violations
    expect(
      rollupBillMatch([
        { status: 'unmatched', qtyVariance: 0, priceVarianceCents: 0 },
        { status: 'matched', qtyVariance: 0, priceVarianceCents: 0 },
      ]),
    ).toBe('matched');
  });

  it('property: any random qty over GRN flips to qty_mismatch', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 100, max: 100_000 }),
        (grnQty, billOver, price) => {
          const r = classifyLineMatch({
            qty: grnQty + billOver,
            unitPriceCents: price,
            poUnitPriceCents: price,
            grnQtyAccepted: grnQty,
          });
          expect(r.status).toBe('qty_mismatch');
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Withholding tax', () => {
  it('returns 0 for null category', () => {
    expect(computeWhtCents(100_000, null)).toBe(0);
  });

  it('services = 3%', () => {
    expect(computeWhtCents(100_000, 'services')).toBe(3000);
    expect(whtRateBp('services')).toBe(300);
  });

  it('rent = 5%, ads = 2%, freight = 1%', () => {
    expect(computeWhtCents(100_000, 'rent')).toBe(5000);
    expect(computeWhtCents(100_000, 'ads')).toBe(2000);
    expect(computeWhtCents(100_000, 'freight')).toBe(1000);
  });

  it('foreign = 15%', () => {
    expect(computeWhtCents(100_000, 'foreign')).toBe(15_000);
  });

  it('property: WHT cents is non-negative and ≤ net for any category × any net', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.constantFrom(
          'services',
          'rent',
          'ads',
          'freight',
          'dividends',
          'interest',
          'foreign',
        ),
        (net, cat) => {
          const wht = computeWhtCents(net, cat as any);
          expect(wht).toBeGreaterThanOrEqual(0);
          expect(wht).toBeLessThanOrEqual(net);
        },
      ),
      { numRuns: 200 },
    );
  });
});
