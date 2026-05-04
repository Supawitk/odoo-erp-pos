import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildClosingBlueprint,
  ClosingBuilderError,
} from '../../src/modules/reports/pp30-closing.builder';

describe('PP.30 closing-journal builder', () => {
  it('payable branch — output > input', () => {
    const b = buildClosingBlueprint(1000, 700);
    expect(b.branch).toBe('payable');
    expect(b.netPayableCents).toBe(300);
    expect(b.lines).toEqual([
      { accountCode: '2201', accountName: expect.stringContaining('Output'), debitCents: 1000, creditCents: 0 },
      { accountCode: '1155', accountName: expect.stringContaining('Input'), debitCents: 0, creditCents: 700 },
      { accountCode: '2210', accountName: expect.any(String), debitCents: 0, creditCents: 300 },
    ]);
  });

  it('refund branch — input > output', () => {
    const b = buildClosingBlueprint(700, 1000);
    expect(b.branch).toBe('refund');
    expect(b.netPayableCents).toBe(-300);
    // Dr 2201 700 + Dr 1158 300 / Cr 1155 1000 — balanced
    const dr = b.lines.reduce((s, l) => s + l.debitCents, 0);
    const cr = b.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(dr).toBe(cr);
    expect(b.lines.find((l) => l.accountCode === '1158')?.debitCents).toBe(300);
  });

  it('wash branch — output == input == nonzero', () => {
    const b = buildClosingBlueprint(500, 500);
    expect(b.branch).toBe('wash');
    expect(b.netPayableCents).toBe(0);
    expect(b.lines).toHaveLength(2); // 2201 Dr + 1155 Cr only
  });

  it('noop branch — both zero', () => {
    const b = buildClosingBlueprint(0, 0);
    expect(b.branch).toBe('noop');
    expect(b.lines).toEqual([]);
  });

  it('output-only — zero input (uncommon but legal)', () => {
    const b = buildClosingBlueprint(800, 0);
    expect(b.branch).toBe('payable');
    expect(b.netPayableCents).toBe(800);
    expect(b.lines).toHaveLength(2); // Dr 2201 + Cr 2210
  });

  it('input-only — zero output (e.g. quiet month with vendor bills)', () => {
    const b = buildClosingBlueprint(0, 600);
    expect(b.branch).toBe('refund');
    expect(b.netPayableCents).toBe(-600);
    expect(b.lines.find((l) => l.accountCode === '1158')?.debitCents).toBe(600);
  });

  // ─── Errors ──────────────────────────────────────────────────────────
  const expectCode = (fn: () => unknown, code: string) => {
    try {
      fn();
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(ClosingBuilderError);
      expect(e.code).toBe(code);
    }
  };
  it('rejects negative input', () => {
    expectCode(() => buildClosingBlueprint(100, -1), 'NEGATIVE_INPUT');
  });
  it('rejects negative output', () => {
    expectCode(() => buildClosingBlueprint(-1, 100), 'NEGATIVE_OUTPUT');
  });

  // ─── Property: any (output, input) ≥ 0 produces a balanced entry ─────
  it('property — debits always equal credits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (output, input) => {
          const b = buildClosingBlueprint(output, input);
          const dr = b.lines.reduce((s, l) => s + l.debitCents, 0);
          const cr = b.lines.reduce((s, l) => s + l.creditCents, 0);
          expect(dr).toBe(cr);
          expect(b.netPayableCents).toBe(output - input);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
