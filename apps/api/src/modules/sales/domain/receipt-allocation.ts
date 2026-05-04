/**
 * Per-receipt WHT and cash allocation for sales-invoice partial payments.
 *
 * Mirror of vendor-bill payment-allocation but for AR. The customer (payer)
 * withholds tax and remits net cash; we recognise the WHT as a receivable
 * (1157) we'll later offset against PND.50 CIT.
 *
 * Why proportional + remainder-on-last:
 *   Thai practice — withholding tax is recognised at the moment of payment,
 *   in proportion to the amount paid. A 50% receipt withholds 50% of the
 *   expected WHT; a flat `floor(amount * wht / total)` per receipt risks
 *   1-satang drift on the final receipt. We pin the LAST receipt to the
 *   remaining balance — guaranteeing Σ receipts == invoice.whtCents to the
 *   satang.
 *
 * Cash splits the same way: cashCents = amountCents − whtCents − bankCharge,
 * and on the final receipt picks up any rounding remainder.
 *
 * Bank charges (merchant fees, wire fees we absorb) are passed through. They
 * don't reduce AR — they're a separate expense. The customer still settled
 * the full amount; we just netted some of it to the bank.
 */

export interface ReceiptAllocationInput {
  /** Gross amount applied to AR for THIS receipt. */
  amountCents: number;
  /** Bank charge customer/bank deducted; we book to 6170. */
  bankChargeCents?: number;
  /** Invoice totals (snapshot when invoice was sent). */
  invoiceTotalCents: number;
  invoiceWhtCents: number;
  /** Σ amount_cents of prior non-voided receipts. */
  paidCentsSoFar: number;
  /** Σ wht_cents of prior non-voided receipts. */
  whtReceivedCentsSoFar: number;
}

export interface ReceiptAllocation {
  whtCents: number;
  cashCents: number;
  bankChargeCents: number;
  isFinal: boolean;
  newPaidCents: number;
  newWhtReceivedCents: number;
  remainingAfter: number;
}

export class ReceiptAllocationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_AMOUNT'
      | 'INVALID_BANK_CHARGE'
      | 'OVERPAYMENT'
      | 'INVALID_INVOICE_TOTAL'
      | 'INVOICE_FULLY_PAID'
      | 'BANK_CHARGE_EXCEEDS_CASH',
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptAllocationError';
  }
}

export function allocateReceiptSplit(
  input: ReceiptAllocationInput,
): ReceiptAllocation {
  const { amountCents, invoiceTotalCents, invoiceWhtCents } = input;
  const bankCharge = input.bankChargeCents ?? 0;
  const paidSoFar = Math.max(0, input.paidCentsSoFar);
  const whtSoFar = Math.max(0, input.whtReceivedCentsSoFar);

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ReceiptAllocationError(
      'INVALID_AMOUNT',
      `amountCents must be a positive integer (got ${amountCents})`,
    );
  }
  if (!Number.isInteger(bankCharge) || bankCharge < 0) {
    throw new ReceiptAllocationError(
      'INVALID_BANK_CHARGE',
      `bankChargeCents must be a non-negative integer (got ${bankCharge})`,
    );
  }
  if (!Number.isInteger(invoiceTotalCents) || invoiceTotalCents <= 0) {
    throw new ReceiptAllocationError(
      'INVALID_INVOICE_TOTAL',
      `invoiceTotalCents must be positive (got ${invoiceTotalCents})`,
    );
  }
  const remaining = invoiceTotalCents - paidSoFar;
  if (remaining <= 0) {
    throw new ReceiptAllocationError(
      'INVOICE_FULLY_PAID',
      `Invoice already fully paid (${paidSoFar} of ${invoiceTotalCents})`,
    );
  }
  if (amountCents > remaining) {
    throw new ReceiptAllocationError(
      'OVERPAYMENT',
      `amountCents=${amountCents} exceeds remaining balance ${remaining}`,
    );
  }

  const isFinal = amountCents === remaining;
  let whtCents: number;
  if (invoiceWhtCents === 0) {
    whtCents = 0;
  } else if (isFinal) {
    whtCents = Math.max(0, invoiceWhtCents - whtSoFar);
  } else {
    whtCents = Math.floor((amountCents * invoiceWhtCents) / invoiceTotalCents);
    if (whtSoFar + whtCents > invoiceWhtCents) {
      whtCents = Math.max(0, invoiceWhtCents - whtSoFar);
    }
  }

  const cashCents = amountCents - whtCents - bankCharge;
  if (cashCents < 0) {
    throw new ReceiptAllocationError(
      'BANK_CHARGE_EXCEEDS_CASH',
      `bankChargeCents=${bankCharge} + whtCents=${whtCents} exceeds amountCents=${amountCents}`,
    );
  }

  return {
    whtCents,
    cashCents,
    bankChargeCents: bankCharge,
    isFinal,
    newPaidCents: paidSoFar + amountCents,
    newWhtReceivedCents: whtSoFar + whtCents,
    remainingAfter: remaining - amountCents,
  };
}
