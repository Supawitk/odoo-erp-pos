/**
 * Thai CIT (Corporate Income Tax) bracket calculator.
 *
 * SME rates apply when BOTH:
 *   - Paid-in capital ≤ ฿5,000,000
 *   - Annual revenue ≤ ฿30,000,000
 *
 * SME brackets (Royal Decree #530, current rates):
 *   ≤ ฿300,000               0%
 *   ฿300,001 – ฿3,000,000   15%
 *   > ฿3,000,000            20%
 *
 * Non-SME (any company that fails either threshold):
 *   flat 20%
 *
 * Loss years: zero tax, but the loss carries forward up to 5 years for
 * future deduction. We don't auto-track NOL here — that's a Phase 5+
 * feature. Caller can pre-net carry-forwards into `taxableIncomeCents`.
 */

export interface CitCalcInput {
  /** Net taxable income for the period (positive number for profit, negative for loss). */
  taxableIncomeCents: number;
  /** Paid-in capital in satang. */
  paidInCapitalCents: number;
  /** Annual revenue in satang (annualised when computing for half-year). */
  annualRevenueCents: number;
}

export interface CitCalcResult {
  taxDueCents: number;
  rateBracket: 'sme' | 'flat20';
  /** Per-bracket breakdown — useful for the UI explanation panel. */
  breakdown: Array<{
    label: string;
    baseCents: number;
    rate: number;
    taxCents: number;
  }>;
}

const SME_CAPITAL_LIMIT_CENTS = 500_000_000; // ฿5M
const SME_REVENUE_LIMIT_CENTS = 3_000_000_000; // ฿30M

const SME_BRACKETS: Array<{ upTo: number | null; rate: number; label: string }> = [
  { upTo: 30_000_000, rate: 0, label: '≤ ฿300,000 (0%)' },
  { upTo: 300_000_000, rate: 0.15, label: '฿300,001–฿3M (15%)' },
  { upTo: null, rate: 0.2, label: '> ฿3M (20%)' },
];

export function computeCit(input: CitCalcInput): CitCalcResult {
  const breakdown: CitCalcResult['breakdown'] = [];

  if (input.taxableIncomeCents <= 0) {
    return { taxDueCents: 0, rateBracket: 'flat20', breakdown };
  }

  const isSme =
    input.paidInCapitalCents <= SME_CAPITAL_LIMIT_CENTS &&
    input.annualRevenueCents <= SME_REVENUE_LIMIT_CENTS;

  if (!isSme) {
    const tax = Math.round(input.taxableIncomeCents * 0.2);
    return {
      taxDueCents: tax,
      rateBracket: 'flat20',
      breakdown: [
        {
          label: 'Flat 20% (non-SME)',
          baseCents: input.taxableIncomeCents,
          rate: 0.2,
          taxCents: tax,
        },
      ],
    };
  }

  // SME: walk the brackets, slicing the income into chunks per bracket.
  let remaining = input.taxableIncomeCents;
  let prevTop = 0;
  let total = 0;
  for (const b of SME_BRACKETS) {
    const top = b.upTo ?? Number.POSITIVE_INFINITY;
    const slice = Math.max(0, Math.min(remaining, top - prevTop));
    if (slice > 0) {
      const tax = Math.round(slice * b.rate);
      total += tax;
      breakdown.push({
        label: b.label,
        baseCents: slice,
        rate: b.rate,
        taxCents: tax,
      });
      remaining -= slice;
    }
    prevTop = top;
    if (remaining <= 0) break;
  }
  return {
    taxDueCents: total,
    rateBracket: 'sme',
    breakdown,
  };
}
