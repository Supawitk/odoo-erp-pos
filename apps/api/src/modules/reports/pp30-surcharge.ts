/**
 * 🇹🇭 PP.30 amendment surcharge — Revenue Code §27.
 *
 * When a VAT-registered merchant files an amendment (PP.30.2) and discovers
 * additional VAT was owed for a previously-filed period, RD charges:
 *
 *   surcharge = 1.5% × additional_vat × months_of_delay
 *
 * Rules:
 *   - "Months of delay" is rounded UP — even one day past the original due date
 *     counts as one month. (RD practice; mirrors §27 paragraph 2.)
 *   - Capped at 200% of the additional VAT (§27 paragraph 4 — the surcharge
 *     can never exceed twice the underlying tax).
 *   - Zero when additional_vat <= 0 (refunds incur no surcharge).
 *   - Original due date is the 15th of the month FOLLOWING the period for paper
 *     filing. (E-filing extends to the 23rd, but we're conservative — using the
 *     paper deadline guarantees we don't under-collect surcharge for an RD audit.)
 *
 * Pure module — no NestJS, no DB. Test-friendly.
 */

const SURCHARGE_RATE_BP = 150; // 1.5% = 150 basis points
const MAX_SURCHARGE_MULTIPLE = 2; // §27: cap at 200% of underlying tax
const PAPER_FILING_DAY = 15;

export interface SurchargeInput {
  additionalVatPayableCents: number;
  /** PP.30 period end. The original due date is the 15th of the *following* month. */
  periodYear: number;
  periodMonth: number;
  /** When the amendment is being filed. Defaults to today. */
  amendmentDate?: Date;
}

export interface SurchargeResult {
  surchargeCents: number;
  /** Months counted (0 if filed before due date or refund). */
  surchargeMonths: number;
  /** ISO date string of the original due date used in the calc. */
  originalDueDate: string;
  /** True when the cap kicked in. */
  cappedAt200pct: boolean;
}

export function computeSurcharge(input: SurchargeInput): SurchargeResult {
  const { additionalVatPayableCents, periodYear, periodMonth } = input;
  const amendmentDate = input.amendmentDate ?? new Date();

  if (
    !Number.isInteger(periodYear) ||
    periodYear < 2000 ||
    periodYear > 9999
  ) {
    throw new RangeError(`periodYear out of range: ${periodYear}`);
  }
  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    throw new RangeError(`periodMonth out of range: ${periodMonth}`);
  }
  if (!Number.isFinite(additionalVatPayableCents)) {
    throw new TypeError(
      `additionalVatPayableCents must be finite: ${additionalVatPayableCents}`,
    );
  }

  // Original PP.30 due date = 15th of the month FOLLOWING the period.
  // April 2026 period → due 2026-05-15. December 2026 → due 2027-01-15.
  const dueYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  const dueMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  const dueDate = new Date(Date.UTC(dueYear, dueMonth - 1, PAPER_FILING_DAY));
  const originalDueDateIso = dueDate.toISOString().slice(0, 10);

  // No surcharge on refund-direction amendments or zero deltas.
  if (additionalVatPayableCents <= 0) {
    return {
      surchargeCents: 0,
      surchargeMonths: 0,
      originalDueDate: originalDueDateIso,
      cappedAt200pct: false,
    };
  }

  // Filed on or before the due date → no surcharge.
  if (amendmentDate.getTime() <= dueDate.getTime()) {
    return {
      surchargeCents: 0,
      surchargeMonths: 0,
      originalDueDate: originalDueDateIso,
      cappedAt200pct: false,
    };
  }

  // Months between dueDate and amendmentDate, rounded UP.
  // "Round up" means: if any day of the month has passed, count the whole month.
  // We compute calendar-month diff and add 1 if there's any time leftover.
  const months = monthsBetweenRoundedUp(dueDate, amendmentDate);

  // Raw surcharge = additional_vat × 1.5% × months. Done in integer satang.
  const rawSurchargeCents = Math.floor(
    (additionalVatPayableCents * SURCHARGE_RATE_BP * months) / 10_000,
  );
  const cap = additionalVatPayableCents * MAX_SURCHARGE_MULTIPLE;
  const cappedAt200pct = rawSurchargeCents > cap;
  const surchargeCents = cappedAt200pct ? cap : rawSurchargeCents;

  return {
    surchargeCents,
    surchargeMonths: months,
    originalDueDate: originalDueDateIso,
    cappedAt200pct,
  };
}

/**
 * Calendar-month delta from `from` to `to`, rounded UP. Both dates must be UTC.
 *
 * Examples:
 *   from=2026-05-15, to=2026-05-15  → 0  (same day, no surcharge)
 *   from=2026-05-15, to=2026-05-16  → 1  (one day late = one full month)
 *   from=2026-05-15, to=2026-06-15  → 1  (exactly one month later)
 *   from=2026-05-15, to=2026-06-16  → 2  (one month + 1 day = two months)
 *   from=2026-05-15, to=2027-05-15  → 12 (exactly one year later)
 *   from=2026-05-15, to=2027-05-16  → 13 (one year + 1 day)
 */
function monthsBetweenRoundedUp(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  const yDiff = to.getUTCFullYear() - from.getUTCFullYear();
  const mDiff = to.getUTCMonth() - from.getUTCMonth();
  const dDiff = to.getUTCDate() - from.getUTCDate();
  const tDiff =
    to.getUTCHours() * 3600 +
    to.getUTCMinutes() * 60 +
    to.getUTCSeconds() -
    (from.getUTCHours() * 3600 +
      from.getUTCMinutes() * 60 +
      from.getUTCSeconds());
  let months = yDiff * 12 + mDiff;
  // Round up if there's any leftover day or time.
  if (dDiff > 0 || (dDiff === 0 && tDiff > 0)) months += 1;
  return Math.max(0, months);
}
