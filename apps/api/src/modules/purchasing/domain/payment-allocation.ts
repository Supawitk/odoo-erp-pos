/**
 * Per-installment WHT and cash allocation for vendor-bill partial payments.
 *
 * Why proportional + remainder-on-last:
 *   Thai practice — withholding tax is recognized at the moment of payment, in
 *   proportion to the amount paid that month. So a 50% payment must withhold
 *   50% of the WHT (not all of it on first, not all on last). A flat
 *   `floor(amount * wht / total)` per installment risks 1-satang drift on the
 *   final payment; we eliminate that by computing the LAST installment as the
 *   remaining balance — `whtCents = bill.whtCents − Σ prior whtCents`. This
 *   guarantees Σ installments == bill.whtCents to the satang.
 *
 * The same trick applies to cash: cashCents = amountCents − whtCents per
 * installment, and on the final installment it picks up any rounding remainder.
 */

export interface PaymentAllocationInput {
  /** Gross amount applied to AP for THIS installment. */
  amountCents: number;
  /** Bank wire / merchant fee deducted from settlement (we absorb to 6170). */
  bankChargeCents?: number;
  /** Bill totals (snapshot when the bill was created). */
  billTotalCents: number;
  billWhtCents: number;
  /** Σ amount_cents of prior non-voided installments. */
  paidCentsSoFar: number;
  /** Σ wht_cents of prior non-voided installments. */
  whtPaidCentsSoFar: number;
}

export interface PaymentAllocation {
  whtCents: number;
  cashCents: number;
  bankChargeCents: number;
  isFinal: boolean;
  /** Bill state after applying THIS installment. */
  newPaidCents: number;
  newWhtPaidCents: number;
  remainingAfter: number;
}

export class PaymentAllocationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_AMOUNT'
      | 'INVALID_BANK_CHARGE'
      | 'OVERPAYMENT'
      | 'INVALID_BILL_TOTAL'
      | 'BILL_FULLY_PAID',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentAllocationError';
  }
}

export function allocatePaymentSplit(
  input: PaymentAllocationInput,
): PaymentAllocation {
  const { amountCents, billTotalCents, billWhtCents } = input;
  const bankCharge = input.bankChargeCents ?? 0;
  const paidSoFar = Math.max(0, input.paidCentsSoFar);
  const whtSoFar = Math.max(0, input.whtPaidCentsSoFar);

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentAllocationError(
      'INVALID_AMOUNT',
      `amountCents must be a positive integer (got ${amountCents})`,
    );
  }
  if (!Number.isInteger(bankCharge) || bankCharge < 0) {
    throw new PaymentAllocationError(
      'INVALID_BANK_CHARGE',
      `bankChargeCents must be a non-negative integer (got ${bankCharge})`,
    );
  }
  if (!Number.isInteger(billTotalCents) || billTotalCents <= 0) {
    throw new PaymentAllocationError(
      'INVALID_BILL_TOTAL',
      `billTotalCents must be positive (got ${billTotalCents})`,
    );
  }
  const remaining = billTotalCents - paidSoFar;
  if (remaining <= 0) {
    throw new PaymentAllocationError(
      'BILL_FULLY_PAID',
      `Bill already fully paid (${paidSoFar} of ${billTotalCents})`,
    );
  }
  if (amountCents > remaining) {
    throw new PaymentAllocationError(
      'OVERPAYMENT',
      `amountCents=${amountCents} exceeds remaining balance ${remaining}`,
    );
  }

  const isFinal = amountCents === remaining;
  let whtCents: number;
  if (billWhtCents === 0) {
    whtCents = 0;
  } else if (isFinal) {
    // Pick up any rounding remainder so totals reconcile exactly.
    whtCents = Math.max(0, billWhtCents - whtSoFar);
  } else {
    whtCents = Math.floor((amountCents * billWhtCents) / billTotalCents);
    // Defensive: never let proportional rounding make Σ exceed the bill total.
    if (whtSoFar + whtCents > billWhtCents) {
      whtCents = Math.max(0, billWhtCents - whtSoFar);
    }
  }

  // AP semantics: cashCents = what LEFT our bank account, including the bank
  // fee (which is an additional outflow on top of the vendor's net). This is
  // the inverse of AR, where the bank fee reduces what hit our account.
  //   cash_out = (amount - wht) + bankCharge    ← total wired + fee deducted
  // The JE: Cr 1120 cash_out + Cr 2203 wht = Dr 2110 amount + Dr 6170 bc
  //         Σ Cr = (amount - wht + bc) + wht = amount + bc = Σ Dr ✓
  // No upper-bound guard on bankCharge in AP — banks can charge any fee.
  const cashCents = amountCents - whtCents + bankCharge;
  return {
    whtCents,
    cashCents,
    bankChargeCents: bankCharge,
    isFinal,
    newPaidCents: paidSoFar + amountCents,
    newWhtPaidCents: whtSoFar + whtCents,
    remainingAfter: remaining - amountCents,
  };
}
