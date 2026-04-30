/**
 * Withholding-tax rate engine — Thailand.
 *
 * Rates per Revenue Code §3 ter / §50 / §69 ter / §70:
 *   services        3%   (most common — design, IT, professional)
 *   rent            5%   (real-property leases)
 *   ads             2%   (advertising)
 *   freight         1%   (transport / logistics)
 *   dividends       10%
 *   interest        15%
 *   foreign         15%  (royalty / service to non-resident)
 *
 * Stored on the bill line as basis points (300 = 3.00%) so the math is
 * integer all the way to the 50-Tawi PDF. Caller picks the category from
 * the supplier-provided context; the engine just computes amounts.
 */
export type WhtCategory =
  | 'services'
  | 'rent'
  | 'ads'
  | 'freight'
  | 'dividends'
  | 'interest'
  | 'foreign';

const RATE_BP_BY_CATEGORY: Record<WhtCategory, number> = {
  services: 300,
  rent: 500,
  ads: 200,
  freight: 100,
  dividends: 1000,
  interest: 1500,
  foreign: 1500,
};

export function whtRateBp(category: WhtCategory): number {
  return RATE_BP_BY_CATEGORY[category];
}

/**
 * Compute WHT cents from a NET amount (always net-of-VAT, regardless of bill
 * VAT mode). RD prescribes WHT on the goods/services value, not on the VAT.
 *
 * Returns 0 for null/undefined category — bills without WHT are common
 * (consumables, raw materials).
 */
export function computeWhtCents(
  netCents: number,
  category: WhtCategory | null | undefined,
): number {
  if (!category) return 0;
  const bp = whtRateBp(category);
  return Math.round((netCents * bp) / 10_000);
}
