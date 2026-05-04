import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  allocatePaymentSplit,
  PaymentAllocationError,
} from '../../src/modules/purchasing/domain/payment-allocation';

describe('Vendor-bill payment allocation', () => {
  // ─── Single-payment cases ─────────────────────────────────────────────
  it('full one-shot payment with WHT', () => {
    // ฿100 net + 7% VAT = 107, WHT 3% on net = 3
    const r = allocatePaymentSplit({
      amountCents: 10700,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(300);
    expect(r.cashCents).toBe(10400);
    expect(r.isFinal).toBe(true);
    expect(r.newPaidCents).toBe(10700);
    expect(r.newWhtPaidCents).toBe(300);
    expect(r.remainingAfter).toBe(0);
  });

  it('full one-shot payment with no WHT', () => {
    const r = allocatePaymentSplit({
      amountCents: 10700,
      billTotalCents: 10700,
      billWhtCents: 0,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(0);
    expect(r.cashCents).toBe(10700);
    expect(r.bankChargeCents).toBe(0);
    expect(r.isFinal).toBe(true);
  });

  // ─── Bank charge — AP semantics differ from AR ─────────────────────────
  // We wire vendor 10700; bank charges us a 35 fee on our side. The vendor
  // gets the full 10700; we lose 10700 + 35 = 10735 from our cash. AP closes
  // for 10700, bank charge is its own expense (Dr 6170 / Cr 1120 35).
  // cashCents stores "what left our bank" = amount - wht + bankCharge.
  it('bank charge increases cash outflow; AP unchanged', () => {
    const r = allocatePaymentSplit({
      amountCents: 10700,
      bankChargeCents: 35,
      billTotalCents: 10700,
      billWhtCents: 0,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(0);
    expect(r.bankChargeCents).toBe(35);
    expect(r.cashCents).toBe(10735); // 10700 wired + 35 fee left our bank
    expect(r.isFinal).toBe(true);
    expect(r.newPaidCents).toBe(10700);
  });

  it('bank charge stacks with WHT — both modify cash differently', () => {
    // 50% installment of 10700, WHT 150 (held back from vendor),
    // bank fee 25. Vendor gets 5350 - 150 = 5200. Bank takes 25 separately.
    // Total cash leaving our account: 5200 + 25 = 5225.
    const r = allocatePaymentSplit({
      amountCents: 5350,
      bankChargeCents: 25,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(r.whtCents).toBe(150);
    expect(r.bankChargeCents).toBe(25);
    expect(r.cashCents).toBe(5225);
    expect(r.isFinal).toBe(false);
  });

  // ─── Two-installment 50/50 ────────────────────────────────────────────
  it('clean 50/50 split — WHT divides evenly', () => {
    // 10700 / 2 = 5350 amount, 300 / 2 = 150 wht each
    const a = allocatePaymentSplit({
      amountCents: 5350,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(a.whtCents).toBe(150);
    expect(a.cashCents).toBe(5200);
    expect(a.isFinal).toBe(false);

    const b = allocatePaymentSplit({
      amountCents: 5350,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 5350,
      whtPaidCentsSoFar: 150,
    });
    expect(b.whtCents).toBe(150);
    expect(b.cashCents).toBe(5200);
    expect(b.isFinal).toBe(true);

    // Σ reconciles exactly
    expect(a.whtCents + b.whtCents).toBe(300);
    expect(a.cashCents + b.cashCents).toBe(10400);
  });

  // ─── Lopsided installments — remainder lands on final ─────────────────
  it('lopsided 30/70 — WHT remainder absorbs rounding on final', () => {
    // 30% of 10700 = 3210, 30% of 300 = 90 (3210 * 300 / 10700 = 89.99...)
    // floor → 89, so first installment recognizes 89, final picks up 211.
    const first = allocatePaymentSplit({
      amountCents: 3210,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    // floor(3210*300/10700) = floor(90.000) → 90 here actually, exact division
    // Try a value that DOES round: 3211
    const firstRound = allocatePaymentSplit({
      amountCents: 3211,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(firstRound.whtCents).toBe(Math.floor((3211 * 300) / 10700));
    expect(firstRound.isFinal).toBe(false);

    const second = allocatePaymentSplit({
      amountCents: 10700 - 3211,
      billTotalCents: 10700,
      billWhtCents: 300,
      paidCentsSoFar: 3211,
      whtPaidCentsSoFar: firstRound.whtCents,
    });
    expect(second.isFinal).toBe(true);
    expect(firstRound.whtCents + second.whtCents).toBe(300);
    expect(firstRound.cashCents + second.cashCents).toBe(10400);
  });

  // ─── Three-installment with rounding ──────────────────────────────────
  it('three irregular installments still reconcile to bill totals', () => {
    const total = 10700;
    const wht = 300;
    const installments = [3333, 3333, total - 3333 - 3333]; // 4034
    let paidSoFar = 0;
    let whtSoFar = 0;
    let lastResult;
    for (let i = 0; i < installments.length; i++) {
      lastResult = allocatePaymentSplit({
        amountCents: installments[i],
        billTotalCents: total,
        billWhtCents: wht,
        paidCentsSoFar: paidSoFar,
        whtPaidCentsSoFar: whtSoFar,
      });
      paidSoFar += installments[i];
      whtSoFar += lastResult.whtCents;
    }
    expect(lastResult!.isFinal).toBe(true);
    expect(whtSoFar).toBe(wht);
    expect(paidSoFar).toBe(total);
  });

  // ─── Errors ───────────────────────────────────────────────────────────
  const expectCode = (fn: () => void, code: string) => {
    try {
      fn();
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PaymentAllocationError);
      expect(e.code).toBe(code);
    }
  };

  it('rejects zero or negative amount', () => {
    expectCode(
      () =>
        allocatePaymentSplit({
          amountCents: 0,
          billTotalCents: 10700,
          billWhtCents: 0,
          paidCentsSoFar: 0,
          whtPaidCentsSoFar: 0,
        }),
      'INVALID_AMOUNT',
    );
    expectCode(
      () =>
        allocatePaymentSplit({
          amountCents: -1,
          billTotalCents: 10700,
          billWhtCents: 0,
          paidCentsSoFar: 0,
          whtPaidCentsSoFar: 0,
        }),
      'INVALID_AMOUNT',
    );
  });

  it('rejects negative bank charge', () => {
    expectCode(
      () =>
        allocatePaymentSplit({
          amountCents: 1000,
          bankChargeCents: -1,
          billTotalCents: 10700,
          billWhtCents: 0,
          paidCentsSoFar: 0,
          whtPaidCentsSoFar: 0,
        }),
      'INVALID_BANK_CHARGE',
    );
  });

  // AP differs from AR: bank fee on AP is an OUTFLOW we add to cash leaving
  // our account, not a deduction from inflow. So it can be arbitrarily large
  // — the bank can charge whatever they want for the wire.
  it('AP allows bank charge larger than amount (it is an extra outflow)', () => {
    const r = allocatePaymentSplit({
      amountCents: 100,
      bankChargeCents: 200,
      billTotalCents: 10700,
      billWhtCents: 0,
      paidCentsSoFar: 0,
      whtPaidCentsSoFar: 0,
    });
    expect(r.bankChargeCents).toBe(200);
    expect(r.cashCents).toBe(300); // 100 to vendor + 200 bank fee
  });

  it('rejects overpayment and double-pay', () => {
    expectCode(
      () =>
        allocatePaymentSplit({
          amountCents: 10800,
          billTotalCents: 10700,
          billWhtCents: 0,
          paidCentsSoFar: 0,
          whtPaidCentsSoFar: 0,
        }),
      'OVERPAYMENT',
    );
    expectCode(
      () =>
        allocatePaymentSplit({
          amountCents: 1,
          billTotalCents: 10700,
          billWhtCents: 0,
          paidCentsSoFar: 10700,
          whtPaidCentsSoFar: 0,
        }),
      'BILL_FULLY_PAID',
    );
  });

  // ─── Property: any partition of a bill must reconcile ────────────────
  it('property — any partition into N installments preserves Σ wht == bill.wht', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }), // bill total
        fc.integer({ min: 0, max: 100_000 }),     // bill wht (must be ≤ total)
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 8 }), // raw shares
        (total, whtRaw, sharesRaw) => {
          const wht = Math.min(whtRaw, total);
          // Normalize shares to sum to total
          const sumShares = sharesRaw.reduce((a, b) => a + b, 0);
          const installments: number[] = [];
          let allocated = 0;
          for (let i = 0; i < sharesRaw.length - 1; i++) {
            const share = Math.max(1, Math.floor((sharesRaw[i] / sumShares) * total));
            const cap = total - allocated - (sharesRaw.length - 1 - i); // leave at least 1 for each remaining
            const safeShare = Math.min(share, Math.max(1, cap));
            if (safeShare <= 0) continue;
            installments.push(safeShare);
            allocated += safeShare;
          }
          const last = total - allocated;
          if (last <= 0) return true; // skip pathological
          installments.push(last);

          let paid = 0;
          let whtPaid = 0;
          let final;
          for (const amt of installments) {
            final = allocatePaymentSplit({
              amountCents: amt,
              billTotalCents: total,
              billWhtCents: wht,
              paidCentsSoFar: paid,
              whtPaidCentsSoFar: whtPaid,
            });
            paid += amt;
            whtPaid += final.whtCents;
          }
          expect(paid).toBe(total);
          expect(whtPaid).toBe(wht);
          expect(final!.isFinal).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
