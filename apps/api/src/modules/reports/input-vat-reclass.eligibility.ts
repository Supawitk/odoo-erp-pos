/**
 * 🇹🇭 §82/3 6-month claim window — pure eligibility predicate.
 *
 * Tax-point = supplier_tax_invoice_date when captured (it's the date on the
 * paper invoice — what RD recognises). Falls back to bill_date for bills
 * entered without supplier-side detail.
 *
 * Deadline = tax_point + 6 calendar months (NOT 180 days — calendar months,
 * because §82/3 is worded "within 6 months from the month of the tax invoice").
 * Boundary day-of-month wraps using the same UTC-month-set convention used by
 * the expiry tracker so the two services agree on what "expired" means.
 *
 * A bill is reclass-eligible when ALL of:
 *   1. status ∈ {posted, partially_paid, paid}        — 1155 was actually debited
 *   2. vatCents > 0                                    — there's input VAT to lose
 *   3. inputVatReclassedAt is null                     — not already reclassed
 *   4. asOfDate > deadline                             — strictly past the window
 */

export interface BillEligibilityInput {
  status: string;
  vatCents: number;
  billDate: string;
  supplierTaxInvoiceDate: string | null;
  inputVatReclassedAt: Date | string | null;
  /** Set when the bill was claimed via a PP.30 closing journal — its 1155
   *  share has already moved to 2210/1158, reclass would double-credit. */
  pp30FilingId?: string | null;
  asOf: string; // ISO yyyy-mm-dd
}

export interface BillEligibilityResult {
  eligible: boolean;
  reason?:
    | 'BILL_NOT_POSTED'
    | 'NO_INPUT_VAT'
    | 'ALREADY_RECLASSED'
    | 'ALREADY_PP30_CLAIMED'
    | 'WITHIN_6MONTHS'
    | 'BILL_VOIDED';
  taxPointDate: string;
  claimDeadline: string;
  daysOverdue: number;
}

const POSTED_STATUSES = new Set(['posted', 'partially_paid', 'paid']);

export function evaluateReclassEligibility(
  input: BillEligibilityInput,
): BillEligibilityResult {
  const taxPointDate = input.supplierTaxInvoiceDate ?? input.billDate;
  const deadline = addMonthsIso(taxPointDate, 6);
  const daysOverdue = daysBetweenIso(deadline, input.asOf);

  if (input.status === 'void') {
    return { eligible: false, reason: 'BILL_VOIDED', taxPointDate, claimDeadline: deadline, daysOverdue };
  }
  if (!POSTED_STATUSES.has(input.status)) {
    return {
      eligible: false,
      reason: 'BILL_NOT_POSTED',
      taxPointDate,
      claimDeadline: deadline,
      daysOverdue,
    };
  }
  if (!input.vatCents || input.vatCents <= 0) {
    return {
      eligible: false,
      reason: 'NO_INPUT_VAT',
      taxPointDate,
      claimDeadline: deadline,
      daysOverdue,
    };
  }
  if (input.inputVatReclassedAt) {
    return {
      eligible: false,
      reason: 'ALREADY_RECLASSED',
      taxPointDate,
      claimDeadline: deadline,
      daysOverdue,
    };
  }
  if (input.pp30FilingId) {
    return {
      eligible: false,
      reason: 'ALREADY_PP30_CLAIMED',
      taxPointDate,
      claimDeadline: deadline,
      daysOverdue,
    };
  }
  if (input.asOf <= deadline) {
    return {
      eligible: false,
      reason: 'WITHIN_6MONTHS',
      taxPointDate,
      claimDeadline: deadline,
      daysOverdue,
    };
  }
  return { eligible: true, taxPointDate, claimDeadline: deadline, daysOverdue };
}

function parseIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addMonthsIso(iso: string, months: number): string {
  const d = parseIso(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1); // park on day 1 to avoid month-overflow
  d.setUTCMonth(d.getUTCMonth() + months);
  // Restore day, capped at the new month's last day
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso).getTime();
  const b = parseIso(toIso).getTime();
  return Math.floor((b - a) / 86400000);
}
