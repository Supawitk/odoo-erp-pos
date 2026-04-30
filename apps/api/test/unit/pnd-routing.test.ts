import { describe, it, expect } from 'vitest';
import { guessTINKind, isValidTIN, normalizeTIN } from '@erp/shared';

/**
 * PND routing rule unit-tests. The full PndService runs against a database;
 * this file isolates the routing logic so we can fast-check it without a DB.
 *
 *   PND.3   →  citizen TIN (lead digit != 0)
 *   PND.53  →  juristic TIN (lead digit == 0)
 *   PND.54  →  no Thai TIN (foreign supplier)
 */

type PndForm = 'PND3' | 'PND53' | 'PND54';

function pickForm(tin: string | null | undefined): PndForm {
  if (!tin) return 'PND54';
  const norm = normalizeTIN(tin);
  if (!/^\d{13}$/.test(norm)) return 'PND54';
  return guessTINKind(norm) === 'juristic' ? 'PND53' : 'PND3';
}

// Build a TIN with a fixed leading digit by setting the 13th (checksum) digit.
function makeValidTin(lead: '1' | '2' | '0', mid = '105551234567'): string {
  // We need a 12-digit prefix + 1 checksum. lead = 1 char, mid = 12 chars,
  // so we drop the first char of mid and concatenate.
  const prefix = lead + mid.slice(1); // 12 digits
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(prefix[i]) * (13 - i);
  }
  const cs = (11 - (sum % 11)) % 10;
  return prefix + cs;
}

describe('PND form routing', () => {
  it('citizen TIN (lead != 0) → PND.3', () => {
    const tin = makeValidTin('1');
    expect(isValidTIN(tin)).toBe(true);
    expect(pickForm(tin)).toBe('PND3');
  });

  it('juristic TIN (lead = 0) → PND.53', () => {
    const tin = makeValidTin('0');
    expect(isValidTIN(tin)).toBe(true);
    expect(pickForm(tin)).toBe('PND53');
  });

  it('alternative citizen TIN (lead = 2) → PND.3', () => {
    const tin = makeValidTin('2');
    expect(isValidTIN(tin)).toBe(true);
    expect(pickForm(tin)).toBe('PND3');
  });

  it('null/empty TIN → PND.54 (foreign)', () => {
    expect(pickForm(null)).toBe('PND54');
    expect(pickForm(undefined)).toBe('PND54');
    expect(pickForm('')).toBe('PND54');
  });

  it('non-numeric or wrong-length TIN → PND.54', () => {
    expect(pickForm('not-a-tin')).toBe('PND54');
    expect(pickForm('123')).toBe('PND54');
    expect(pickForm('12345678901234')).toBe('PND54'); // 14 digits
  });

  it('TIN with hyphens still routes correctly after normalisation', () => {
    const tin = makeValidTin('1');
    const formatted = `${tin[0]}-${tin.slice(1, 5)}-${tin.slice(5, 10)}-${tin.slice(10, 12)}-${tin[12]}`;
    expect(pickForm(formatted)).toBe('PND3');
  });
});

// ─── WHT-rate × 50-Tawi line aggregation ────────────────────────────────────
// Mirror the service's per-line aggregation logic against fixed inputs.

describe('Bill-level WHT aggregation by category', () => {
  it('aggregates net + wht across lines sharing a category', () => {
    type Line = { netCents: number; whtCents: number; category: string };
    const lines: Line[] = [
      { netCents: 50000, whtCents: 1500, category: 'services' }, // 50000 × 3%
      { netCents: 30000, whtCents: 900, category: 'services' },
      { netCents: 100000, whtCents: 5000, category: 'rent' }, // 100000 × 5%
    ];

    const acc = new Map<string, { net: number; wht: number; n: number }>();
    for (const l of lines) {
      const cur = acc.get(l.category) ?? { net: 0, wht: 0, n: 0 };
      cur.net += l.netCents;
      cur.wht += l.whtCents;
      cur.n += 1;
      acc.set(l.category, cur);
    }

    expect(acc.get('services')).toEqual({ net: 80000, wht: 2400, n: 2 });
    expect(acc.get('rent')).toEqual({ net: 100000, wht: 5000, n: 1 });
  });
});
