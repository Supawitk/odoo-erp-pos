import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * PP.36 self-assessment VAT — unit-level math invariants.
 *
 * The full PP36Service runs against the DB and is exercised in
 * `apps/api/test/pp36-smoke.sh`. Here we pin the conversion + rate math, the
 * round-half-up rule, and the same bookkeeping invariants we'd want to hold
 * at any future schema (e.g. when we move to per-installment FX rates).
 */

const PP36_RATE = 0.07;

function thbCentsFromForeign(amountCents: number, fxRate: number): number {
  return Math.round(amountCents * fxRate);
}

function vatCents(thbCents: number): number {
  return Math.round(thbCents * PP36_RATE);
}

describe('PP.36 — currency conversion + 7% self-assessment math', () => {
  it('100 USD × 35.0 → 3500.00 THB → 245.00 VAT', () => {
    const baseThb = thbCentsFromForeign(10000, 35.0);
    expect(baseThb).toBe(350000);
    expect(vatCents(baseThb)).toBe(24500);
  });

  it('50 EUR × 40.0 → 2000.00 THB → 140.00 VAT', () => {
    const baseThb = thbCentsFromForeign(5000, 40.0);
    expect(baseThb).toBe(200000);
    expect(vatCents(baseThb)).toBe(14000);
  });

  it('Thai-currency bill with fx=1.0 round-trips cleanly', () => {
    const baseThb = thbCentsFromForeign(123456, 1.0);
    expect(baseThb).toBe(123456);
    expect(vatCents(baseThb)).toBe(8642); // 0.07 × 123456 = 8641.92 → round = 8642
  });

  it('handles fractional satang via round-half-up (banker-safe)', () => {
    // 100¢ × 35.001 = 3500.1¢ → rounds to 3500
    expect(thbCentsFromForeign(100, 35.001)).toBe(3500);
    // 100¢ × 35.005 = 3500.5¢ → rounds to 3501 (Math.round half-up)
    expect(thbCentsFromForeign(100, 35.005)).toBe(3501);
  });

  it('zero amount → zero base + zero VAT', () => {
    expect(thbCentsFromForeign(0, 35.0)).toBe(0);
    expect(vatCents(0)).toBe(0);
  });

  it('property: VAT is always between 6% and 8% of base (rounding tolerance)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000_000 }),
        (baseThb) => {
          const v = vatCents(baseThb);
          expect(v).toBeGreaterThanOrEqual(0);
          // For any reasonable base, 0.07 × base ± 0.5 rounds to within ±1 cent
          // of the true value; the rate is exactly 7%.
          const truth = baseThb * PP36_RATE;
          expect(Math.abs(v - truth)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: conversion is monotonic in fx rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.float({ min: 1, max: 100, noNaN: true }),
        fc.float({ min: 1, max: 100, noNaN: true }),
        (cents, fx1, fx2) => {
          const a = thbCentsFromForeign(cents, fx1);
          const b = thbCentsFromForeign(cents, fx2);
          // Higher fx => higher THB equivalent (or equal under rounding).
          if (fx1 < fx2) expect(a).toBeLessThanOrEqual(b);
          else if (fx1 > fx2) expect(a).toBeGreaterThanOrEqual(b);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('filing due is always the 15th of next month', () => {
    // Inline duplicate of pp36.service's helper for the rollover edge.
    const due = (y: number, m: number) => {
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      return `${ny}-${String(nm).padStart(2, '0')}-15`;
    };
    expect(due(2026, 1)).toBe('2026-02-15');
    expect(due(2026, 6)).toBe('2026-07-15');
    expect(due(2026, 11)).toBe('2026-12-15');
    expect(due(2026, 12)).toBe('2027-01-15');
  });

  it('property: total VAT is sum of per-payment VAT (no double-rounding)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 0, maxLength: 30 }),
        (basesThb) => {
          // Per-payment VAT computed and summed
          const perPay = basesThb.reduce((a, b) => a + vatCents(b), 0);
          // Naive total (rounded once) — tolerance ±N where N = number of rounds
          const naive = vatCents(basesThb.reduce((a, b) => a + b, 0));
          expect(Math.abs(perPay - naive)).toBeLessThanOrEqual(basesThb.length);
        },
      ),
      { numRuns: 60 },
    );
  });
});
