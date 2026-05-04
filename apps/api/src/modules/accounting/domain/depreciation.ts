/**
 * Straight-line depreciation calculator.
 *
 * Conservative monthly schedule:
 *   monthly_amount = (cost - salvage) / useful_life_months  (rounded down to satang)
 *   final month catches the rounding remainder so accumulated never exceeds (cost - salvage)
 *
 * Full-month convention: depreciation starts the month *after* acquisition
 * (typical Thai practice — no proration for partial first month). The caller
 * supplies `depreciationStartDate`; we compute "is this period due?" against it.
 */

export interface DepreciationInput {
  acquisitionCostCents: number;
  salvageValueCents: number;
  usefulLifeMonths: number;
  depreciationStartDate: string; // YYYY-MM-DD
  /** Sum of depreciation already posted for this asset. */
  accumulatedSoFarCents: number;
  /** Period being calculated, YYYY-MM. */
  period: string;
}

export interface DepreciationResult {
  /** 0 if no depreciation due this period (not started, fully depreciated, etc.) */
  amountCents: number;
  /** Reason when amountCents is 0 — useful for diagnostics + UI hints. */
  reason?:
    | 'not_started'
    | 'fully_depreciated'
    | 'zero_useful_life'
    | 'negative_base'
    | 'period_already_posted';
}

export function depreciationFor(input: DepreciationInput): DepreciationResult {
  const {
    acquisitionCostCents,
    salvageValueCents,
    usefulLifeMonths,
    depreciationStartDate,
    accumulatedSoFarCents,
    period,
  } = input;

  if (usefulLifeMonths <= 0) return { amountCents: 0, reason: 'zero_useful_life' };

  const depreciableBase = acquisitionCostCents - salvageValueCents;
  if (depreciableBase <= 0) return { amountCents: 0, reason: 'negative_base' };

  if (accumulatedSoFarCents >= depreciableBase) {
    return { amountCents: 0, reason: 'fully_depreciated' };
  }

  // "not started yet" — period < start month
  const startPeriod = depreciationStartDate.slice(0, 7); // YYYY-MM
  if (period < startPeriod) return { amountCents: 0, reason: 'not_started' };

  // Standard monthly slice — round down so we don't over-depreciate.
  const monthly = Math.floor(depreciableBase / usefulLifeMonths);

  // Final-month rounding: if posting `monthly` would exceed the remaining
  // depreciable base, post only what remains. Catches integer truncation
  // remainders so accumulated lands exactly at depreciableBase.
  const remaining = depreciableBase - accumulatedSoFarCents;
  const amountCents = Math.min(monthly, remaining);

  return { amountCents };
}

/**
 * Generate the full schedule for an asset — useful for UI preview ("show me
 * all 60 months at a glance") and for property-based testing.
 */
export function depreciationSchedule(input: {
  acquisitionCostCents: number;
  salvageValueCents: number;
  usefulLifeMonths: number;
  depreciationStartDate: string;
}): Array<{ period: string; amountCents: number; cumulativeCents: number }> {
  const out: Array<{ period: string; amountCents: number; cumulativeCents: number }> = [];
  let acc = 0;
  // Iterate up to useful life + 1 to include a "remainder" month if rounding occurs.
  const start = parsePeriod(input.depreciationStartDate.slice(0, 7));
  for (let i = 0; i < input.usefulLifeMonths + 1; i++) {
    const periodMs = addMonths(start, i);
    const period = formatPeriod(periodMs);
    const r = depreciationFor({
      acquisitionCostCents: input.acquisitionCostCents,
      salvageValueCents: input.salvageValueCents,
      usefulLifeMonths: input.usefulLifeMonths,
      depreciationStartDate: input.depreciationStartDate,
      accumulatedSoFarCents: acc,
      period,
    });
    if (r.amountCents > 0) {
      acc += r.amountCents;
      out.push({ period, amountCents: r.amountCents, cumulativeCents: acc });
    } else if (r.reason === 'fully_depreciated') {
      break;
    }
  }
  return out;
}

function parsePeriod(p: string): Date {
  const [y, m] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}
function formatPeriod(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

/**
 * Disposal journal blueprint. When an asset is sold/scrapped:
 *   Dr Cash (sale proceeds)
 *   Dr Accumulated Depreciation (zero out the contra)
 *   Cr Asset Account (zero out the asset cost)
 *   Dr/Cr Gain or Loss on Disposal (the plug)
 *
 * gain/loss = proceeds + accumulated - cost. Positive = gain (Cr 7110),
 * negative = loss (Dr 8120).
 */
export function disposalJournalLines(input: {
  acquisitionCostCents: number;
  accumulatedDepreciationCents: number;
  disposalProceedsCents: number;
  cashAccountCode: string;
  assetAccountCode: string;
  accumulatedDepreciationAccount: string;
  gainAccountCode?: string; // default 7120 Gain on disposal
  lossAccountCode?: string; // default 8120 Loss on disposal
}): Array<{ accountCode: string; debitCents: number; creditCents: number }> {
  const gainLoss =
    input.disposalProceedsCents +
    input.accumulatedDepreciationCents -
    input.acquisitionCostCents;
  const lines: Array<{ accountCode: string; debitCents: number; creditCents: number }> = [];

  if (input.disposalProceedsCents > 0) {
    lines.push({
      accountCode: input.cashAccountCode,
      debitCents: input.disposalProceedsCents,
      creditCents: 0,
    });
  }
  if (input.accumulatedDepreciationCents > 0) {
    lines.push({
      accountCode: input.accumulatedDepreciationAccount,
      debitCents: input.accumulatedDepreciationCents,
      creditCents: 0,
    });
  }
  lines.push({
    accountCode: input.assetAccountCode,
    debitCents: 0,
    creditCents: input.acquisitionCostCents,
  });
  if (gainLoss > 0) {
    lines.push({
      accountCode: input.gainAccountCode ?? '7120',
      debitCents: 0,
      creditCents: gainLoss,
    });
  } else if (gainLoss < 0) {
    lines.push({
      accountCode: input.lossAccountCode ?? '8120',
      debitCents: -gainLoss,
      creditCents: 0,
    });
  }
  return lines;
}
