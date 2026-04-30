import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildCogsEntry,
  buildRefundEntry,
  buildSaleEntry,
  paymentToAccount,
  vatFromBreakdown,
  dateOnly,
} from '../../src/modules/accounting/domain/pos-journal-builders';

describe('paymentToAccount', () => {
  it('routes cash to 1110, card to 1135, promptpay/qr to 1120', () => {
    expect(paymentToAccount('cash')).toBe('1110');
    expect(paymentToAccount('card')).toBe('1135');
    expect(paymentToAccount('promptpay')).toBe('1120');
    expect(paymentToAccount('qr')).toBe('1120');
    // unknown channel falls back to cash account so backfill never fails on
    // a one-off payment method that hasn't been added to the table.
    expect(paymentToAccount('voucher')).toBe('1110');
  });
});

describe('vatFromBreakdown', () => {
  it('reads totalVatCents preferentially', () => {
    expect(vatFromBreakdown({ totalVatCents: 700 })).toBe(700);
  });
  it('falls back to vatCents', () => {
    expect(vatFromBreakdown({ vatCents: 350 })).toBe(350);
  });
  it('sums lines[].vatCents when nothing else is present', () => {
    expect(
      vatFromBreakdown({
        lines: [{ vatCents: 70 }, { vatCents: 30 }, { vatCents: 100 }],
      }),
    ).toBe(200);
  });
  it('returns 0 for null / undefined / non-objects', () => {
    expect(vatFromBreakdown(null)).toBe(0);
    expect(vatFromBreakdown(undefined)).toBe(0);
    expect(vatFromBreakdown(42)).toBe(0);
    expect(vatFromBreakdown('foo')).toBe(0);
  });
});

describe('dateOnly', () => {
  it('extracts ISO yyyy-mm-dd from a Date', () => {
    expect(dateOnly(new Date('2026-04-30T12:34:56Z'))).toBe('2026-04-30');
  });
  it('falls back to today on null/undefined', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(dateOnly(null)).toBe(today);
    expect(dateOnly(undefined as any)).toBe(today);
  });
});

describe('buildSaleEntry — Dr cash / Cr revenue / Cr VAT', () => {
  it('balances debit ≡ credit on a standard sale with VAT', () => {
    const entry = buildSaleEntry({
      date: '2026-04-30',
      orderId: 'order-123',
      documentNumber: 'TX-001',
      channelAccount: '1110',
      netCents: 1000,
      vatCents: 70,
      currency: 'THB',
    });
    const debit = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = entry.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(1070);
  });

  it('omits the 2201 VAT line when vatCents=0 (zero-rated/exempt sale)', () => {
    const entry = buildSaleEntry({
      date: '2026-04-30',
      orderId: 'order-1',
      documentNumber: null,
      channelAccount: '1110',
      netCents: 500,
      vatCents: 0,
      currency: 'THB',
    });
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.some((l) => l.accountCode === '2201')).toBe(false);
  });

  it('routes to the right channel account', () => {
    for (const acct of ['1110', '1120', '1135']) {
      const entry = buildSaleEntry({
        date: '2026-04-30',
        orderId: 'order-x',
        documentNumber: null,
        channelAccount: acct,
        netCents: 1000,
        vatCents: 70,
        currency: 'THB',
      });
      const debitLine = entry.lines.find((l) => l.debitCents > 0)!;
      expect(debitLine.accountCode).toBe(acct);
    }
  });

  it('property: sale entry is balanced for any reasonable amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99_999_999 }),
        fc.integer({ min: 0, max: 9_999_999 }),
        (net, vat) => {
          const e = buildSaleEntry({
            date: '2026-04-30',
            orderId: 'p',
            documentNumber: null,
            channelAccount: '1110',
            netCents: net,
            vatCents: vat,
            currency: 'THB',
          });
          const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
          const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
          return d === c && d === net + vat;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('buildRefundEntry — Dr returns + Dr VAT / Cr cash', () => {
  it('balances and reverses sale shape', () => {
    const entry = buildRefundEntry({
      date: '2026-04-30',
      orderId: 'order-9',
      documentNumber: 'CN-001',
      channelAccount: '1110',
      netCents: 500,
      vatCents: 35,
      currency: 'THB',
    });
    const debit = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = entry.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(535);
    // Credit side should be the channel account (refunding the customer)
    const creditLine = entry.lines.find((l) => l.creditCents > 0)!;
    expect(creditLine.accountCode).toBe('1110');
    // Debit side should include 4140 (sales returns)
    expect(entry.lines.some((l) => l.accountCode === '4140' && l.debitCents > 0)).toBe(true);
  });
});

describe('buildCogsEntry — Dr 5100 / Cr 1161 (or reverse on refund)', () => {
  it('sale: Dr 5100 / Cr 1161 balanced', () => {
    const entry = buildCogsEntry({
      date: '2026-04-30',
      orderId: 'order-1',
      totalCostCents: 800,
      isRefund: false,
      currency: 'THB',
    });
    expect(entry.lines).toHaveLength(2);
    const cogs = entry.lines.find((l) => l.accountCode === '5100')!;
    const inv = entry.lines.find((l) => l.accountCode === '1161')!;
    expect(cogs.debitCents).toBe(800);
    expect(cogs.creditCents).toBe(0);
    expect(inv.debitCents).toBe(0);
    expect(inv.creditCents).toBe(800);
  });

  it('refund: Dr 1161 / Cr 5100 balanced', () => {
    const entry = buildCogsEntry({
      date: '2026-04-30',
      orderId: 'order-1',
      totalCostCents: 800,
      isRefund: true,
      currency: 'THB',
    });
    const cogs = entry.lines.find((l) => l.accountCode === '5100')!;
    const inv = entry.lines.find((l) => l.accountCode === '1161')!;
    expect(inv.debitCents).toBe(800);
    expect(cogs.creditCents).toBe(800);
  });

  it('takes absolute value of cost (refund signs are not propagated twice)', () => {
    const entry = buildCogsEntry({
      date: '2026-04-30',
      orderId: 'order-1',
      totalCostCents: -500, // someone passed a signed cost
      isRefund: false,
      currency: 'THB',
    });
    const debit = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    expect(debit).toBe(500);
  });
});

describe('Idempotency anchor: source_module + source_id', () => {
  it('every builder stamps source_module + source_id so backfill can dedupe', () => {
    const sale = buildSaleEntry({
      date: '2026-04-30',
      orderId: 'abc-123',
      documentNumber: null,
      channelAccount: '1110',
      netCents: 100,
      vatCents: 7,
      currency: 'THB',
    });
    const refund = buildRefundEntry({
      date: '2026-04-30',
      orderId: 'abc-123',
      documentNumber: null,
      channelAccount: '1110',
      netCents: 100,
      vatCents: 7,
      currency: 'THB',
    });
    const cogs = buildCogsEntry({
      date: '2026-04-30',
      orderId: 'abc-123',
      totalCostCents: 50,
      isRefund: false,
      currency: 'THB',
    });

    expect(sale.sourceModule).toBe('pos');
    expect(sale.sourceId).toBe('abc-123');
    expect(refund.sourceModule).toBe('pos');
    expect(refund.sourceId).toBe('abc-123');
    expect(cogs.sourceModule).toBe('pos-cogs');
    expect(cogs.sourceId).toBe('abc-123');
  });
});
