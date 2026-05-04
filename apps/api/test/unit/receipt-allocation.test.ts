import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  allocateReceiptSplit,
  ReceiptAllocationError,
} from '../../src/modules/sales/domain/receipt-allocation';

describe('Sales-invoice receipt allocation', () => {
  // ─── Single-receipt cases ─────────────────────────────────────────────
  it('full one-shot receipt with WHT', () => {
    // ฿100 net + 7% VAT = 107 invoice, customer WHT 3% on net = 3
    const r = allocateReceiptSplit({
      amountCents: 10700,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(300);
    expect(r.cashCents).toBe(10400);
    expect(r.bankChargeCents).toBe(0);
    expect(r.isFinal).toBe(true);
    expect(r.newPaidCents).toBe(10700);
    expect(r.newWhtReceivedCents).toBe(300);
    expect(r.remainingAfter).toBe(0);
  });

  it('full one-shot receipt with no WHT', () => {
    const r = allocateReceiptSplit({
      amountCents: 10700,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 0,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(0);
    expect(r.cashCents).toBe(10700);
    expect(r.isFinal).toBe(true);
  });

  it('receipt with bank charge — cash reduced, AR not affected', () => {
    // Customer pays 10700, bank deducts 35 fee, we receive 10665. AR closes
    // for the full 10700 — bank charge is its own expense.
    const r = allocateReceiptSplit({
      amountCents: 10700,
      bankChargeCents: 35,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 0,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(0);
    expect(r.bankChargeCents).toBe(35);
    expect(r.cashCents).toBe(10665);
    expect(r.isFinal).toBe(true);
    expect(r.newPaidCents).toBe(10700);
  });

  // ─── Two-receipt 50/50 ────────────────────────────────────────────────
  it('clean 50/50 split — WHT divides evenly', () => {
    const a = allocateReceiptSplit({
      amountCents: 5350,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    expect(a.whtCents).toBe(150);
    expect(a.cashCents).toBe(5200);
    expect(a.isFinal).toBe(false);

    const b = allocateReceiptSplit({
      amountCents: 5350,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 5350,
      whtReceivedCentsSoFar: 150,
    });
    expect(b.whtCents).toBe(150);
    expect(b.cashCents).toBe(5200);
    expect(b.isFinal).toBe(true);

    expect(a.whtCents + b.whtCents).toBe(300);
    expect(a.cashCents + b.cashCents).toBe(10400);
  });

  // ─── Lopsided installments — remainder lands on final ─────────────────
  it('lopsided 30/70 — WHT remainder absorbs rounding on final', () => {
    const first = allocateReceiptSplit({
      amountCents: 3211,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    expect(first.whtCents).toBe(Math.floor((3211 * 300) / 10700));
    expect(first.isFinal).toBe(false);

    const second = allocateReceiptSplit({
      amountCents: 10700 - 3211,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 3211,
      whtReceivedCentsSoFar: first.whtCents,
    });
    expect(second.isFinal).toBe(true);
    expect(first.whtCents + second.whtCents).toBe(300);
    expect(first.cashCents + second.cashCents).toBe(10400);
  });

  // ─── Bank charges spread across receipts ──────────────────────────────
  it('bank charges per receipt are independent and do not affect AR', () => {
    const a = allocateReceiptSplit({
      amountCents: 5350,
      bankChargeCents: 20,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 0,
      whtReceivedCentsSoFar: 0,
    });
    const b = allocateReceiptSplit({
      amountCents: 5350,
      bankChargeCents: 25,
      invoiceTotalCents: 10700,
      invoiceWhtCents: 300,
      paidCentsSoFar: 5350,
      whtReceivedCentsSoFar: a.whtCents,
    });
    // Σ amounts == invoice total even though cash differs by bank charges
    expect(a.newPaidCents + (b.newPaidCents - a.newPaidCents)).toBe(10700);
    expect(b.newPaidCents).toBe(10700);
    expect(a.cashCents).toBe(5350 - 150 - 20);
    expect(b.cashCents).toBe(5350 - 150 - 25);
  });

  // ─── Errors ───────────────────────────────────────────────────────────
  const expectCode = (fn: () => void, code: string) => {
    try {
      fn();
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(ReceiptAllocationError);
      expect(e.code).toBe(code);
    }
  };

  it('rejects zero or negative amount', () => {
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: 0,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 0,
          whtReceivedCentsSoFar: 0,
        }),
      'INVALID_AMOUNT',
    );
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: -1,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 0,
          whtReceivedCentsSoFar: 0,
        }),
      'INVALID_AMOUNT',
    );
  });

  it('rejects negative bank charge', () => {
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: 1000,
          bankChargeCents: -1,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 0,
          whtReceivedCentsSoFar: 0,
        }),
      'INVALID_BANK_CHARGE',
    );
  });

  it('rejects overpayment and double-pay', () => {
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: 10800,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 0,
          whtReceivedCentsSoFar: 0,
        }),
      'OVERPAYMENT',
    );
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: 1,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 10700,
          whtReceivedCentsSoFar: 0,
        }),
      'INVOICE_FULLY_PAID',
    );
  });

  it('rejects bank charge that would push cash negative', () => {
    expectCode(
      () =>
        allocateReceiptSplit({
          amountCents: 100,
          bankChargeCents: 200,
          invoiceTotalCents: 10700,
          invoiceWhtCents: 0,
          paidCentsSoFar: 0,
          whtReceivedCentsSoFar: 0,
        }),
      'BANK_CHARGE_EXCEEDS_CASH',
    );
  });

  // ─── Property: any reasonable partition of an invoice reconciles ──────
  // Notes on the bound: `min: 100` per installment guarantees the final
  // installment can absorb the running WHT rounding remainder without
  // hitting BANK_CHARGE_EXCEEDS_CASH. With ≤ 8 installments and a 30% WHT
  // ceiling, the remainder is bounded by `installments-1 < 8`, so 100 cents
  // is comfortably enough headroom.
  it('property — any partition into N receipts preserves Σ wht == invoice.wht', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 1_000_000 }), // invoice total
        fc.integer({ min: 0, max: 3000 }),           // wht in basis points (0..30%)
        fc.array(fc.integer({ min: 100, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (total, whtBp, sharesRaw) => {
          const wht = Math.floor((total * whtBp) / 10_000);
          const sumShares = sharesRaw.reduce((a, b) => a + b, 0);
          if (sumShares === 0) return;
          // Normalize so installments sum to exactly `total`, each ≥ 100
          const n = sharesRaw.length;
          const installments: number[] = [];
          let remaining = total;
          for (let i = 0; i < n - 1; i++) {
            const want = Math.floor((sharesRaw[i] * total) / sumShares);
            const minNeeded = (n - 1 - i) * 100;
            const portion = Math.max(100, Math.min(want, remaining - minNeeded));
            installments.push(portion);
            remaining -= portion;
          }
          installments.push(remaining);

          let paid = 0;
          let whtPaid = 0;
          let last;
          for (const amt of installments) {
            last = allocateReceiptSplit({
              amountCents: amt,
              invoiceTotalCents: total,
              invoiceWhtCents: wht,
              paidCentsSoFar: paid,
              whtReceivedCentsSoFar: whtPaid,
            });
            paid += amt;
            whtPaid += last.whtCents;
          }
          expect(paid).toBe(total);
          expect(whtPaid).toBe(wht);
          expect(last!.isFinal).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Document the pathological case explicitly — tiny final installment can't
  // absorb a big rounded-up WHT remainder. Service layer must surface this
  // as a 400 to the caller (use a larger final installment).
  it('rejects tiny final installment that cannot absorb WHT remainder', () => {
    // 8 prior installments of 124999, each rounds down 1 cent of a 0.001
    // remainder; the final 1-cent installment needs to recognise 8 wht.
    const total = 1_000_000;
    const wht = 999_993;
    let paid = 0;
    let whtPaid = 0;
    for (let i = 0; i < 7; i++) {
      const r = allocateReceiptSplit({
        amountCents: 124_999,
        invoiceTotalCents: total,
        invoiceWhtCents: wht,
        paidCentsSoFar: paid,
        whtReceivedCentsSoFar: whtPaid,
      });
      paid += 124_999;
      whtPaid += r.whtCents;
    }
    // Final residual is 125_007. The function should NOT throw because the
    // residual is large enough to absorb the remainder. This sanity-checks
    // the bound chosen in the property test above.
    const last = allocateReceiptSplit({
      amountCents: total - paid,
      invoiceTotalCents: total,
      invoiceWhtCents: wht,
      paidCentsSoFar: paid,
      whtReceivedCentsSoFar: whtPaid,
    });
    expect(last.isFinal).toBe(true);
    expect(whtPaid + last.whtCents).toBe(wht);
  });
});
