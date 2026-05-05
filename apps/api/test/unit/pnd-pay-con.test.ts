import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { payConFor, type WhtPayerMode } from '../../src/modules/reports/pnd-rd-v1';

/**
 * PAY_CON swap matrix. RD's "เงื่อนไขการหักภาษี" code on every PND detail row.
 * Codes 2 and 3 swap meaning between PND.53 and PND.3 / PND.54 — the gotcha
 * we're exhaustively pinning here.
 */
describe('payConFor — PND PAY_CON swap matrix', () => {
  describe('PND.53 (juristic supplier)', () => {
    it('withhold → 1', () => {
      expect(payConFor('PND53', 'withhold')).toBe('1');
    });
    it('paid_one_time → 2', () => {
      expect(payConFor('PND53', 'paid_one_time')).toBe('2');
    });
    it('paid_continuously → 3', () => {
      expect(payConFor('PND53', 'paid_continuously')).toBe('3');
    });
  });

  describe('PND.3 (natural-person supplier)', () => {
    it('withhold → 1', () => {
      expect(payConFor('PND3', 'withhold')).toBe('1');
    });
    it('paid_one_time → 3 (swap)', () => {
      expect(payConFor('PND3', 'paid_one_time')).toBe('3');
    });
    it('paid_continuously → 2 (swap)', () => {
      expect(payConFor('PND3', 'paid_continuously')).toBe('2');
    });
  });

  describe('PND.54 (foreign supplier)', () => {
    // PND.54 follows the same swap as PND.3 (it's the "non-juristic-Thai" branch).
    it('withhold → 1', () => {
      expect(payConFor('PND54', 'withhold')).toBe('1');
    });
    it('paid_one_time → 3', () => {
      expect(payConFor('PND54', 'paid_one_time')).toBe('3');
    });
    it('paid_continuously → 2', () => {
      expect(payConFor('PND54', 'paid_continuously')).toBe('2');
    });
  });

  describe('properties', () => {
    it('always returns one of "1" | "2" | "3"', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<'PND3' | 'PND53' | 'PND54'>('PND3', 'PND53', 'PND54'),
          fc.constantFrom<WhtPayerMode>('withhold', 'paid_one_time', 'paid_continuously'),
          (form, mode) => {
            const code = payConFor(form, mode);
            expect(['1', '2', '3']).toContain(code);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('withhold always emits 1 regardless of form', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<'PND3' | 'PND53' | 'PND54'>('PND3', 'PND53', 'PND54'),
          (form) => {
            expect(payConFor(form, 'withhold')).toBe('1');
          },
        ),
        { numRuns: 30 },
      );
    });

    it('PND.53 and PND.3 disagree on the absorbed-WHT codes (the swap)', () => {
      // The whole point of the helper. If these ever produce the same value
      // for the same non-withhold mode, the swap is broken.
      for (const mode of ['paid_one_time', 'paid_continuously'] as const) {
        expect(payConFor('PND53', mode)).not.toBe(payConFor('PND3', mode));
      }
    });

    it('PND.3 and PND.54 always agree (same branch)', () => {
      for (const mode of ['withhold', 'paid_one_time', 'paid_continuously'] as const) {
        expect(payConFor('PND3', mode)).toBe(payConFor('PND54', mode));
      }
    });
  });
});
