/**
 * Three-way match: Vendor Bill ↔ Purchase Order ↔ Goods Receipt.
 *
 * For each bill line we expect:
 *   1. qty ≤ qty_received_on_GRN   (you can't be billed for goods you didn't receive)
 *   2. unit_price within tolerance of PO unit_price (catch supplier-side overcharges)
 *
 * Mismatches become `qty_mismatch` / `price_mismatch` and require an explicit
 * supervisor `overrideMatchBy` to post. A line with no PO/GRN reference is
 * tagged `unmatched` — common for service bills that bypass the PO flow.
 *
 * Tolerance defaults: ±1% on price. Make it tighter for fixed-price contracts
 * by passing `priceToleranceBp` at call time.
 */

export type LineMatchStatus =
  | 'matched'
  | 'qty_mismatch'
  | 'price_mismatch'
  | 'unmatched';

export interface LineMatchInput {
  qty: number;
  unitPriceCents: number;
  poUnitPriceCents?: number | null;
  grnQtyAccepted?: number | null;
}

export interface LineMatchResult {
  status: LineMatchStatus;
  /** signed: positive = bill exceeds PO/GRN expectation */
  qtyVariance: number;
  priceVarianceCents: number;
}

export function classifyLineMatch(
  input: LineMatchInput,
  options: { priceToleranceBp?: number } = {},
): LineMatchResult {
  const tol = options.priceToleranceBp ?? 100; // 1%

  const hasPoRef =
    input.poUnitPriceCents !== undefined && input.poUnitPriceCents !== null;
  const hasGrnRef =
    input.grnQtyAccepted !== undefined && input.grnQtyAccepted !== null;

  if (!hasPoRef && !hasGrnRef) {
    return { status: 'unmatched', qtyVariance: 0, priceVarianceCents: 0 };
  }

  const qtyVariance = hasGrnRef
    ? input.qty - (input.grnQtyAccepted as number)
    : 0;
  const priceVarianceCents = hasPoRef
    ? input.unitPriceCents - (input.poUnitPriceCents as number)
    : 0;

  if (hasGrnRef && qtyVariance > 0) {
    return { status: 'qty_mismatch', qtyVariance, priceVarianceCents };
  }
  if (hasPoRef) {
    const allowed = Math.round(
      ((input.poUnitPriceCents as number) * tol) / 10_000,
    );
    if (Math.abs(priceVarianceCents) > allowed) {
      return {
        status: 'price_mismatch',
        qtyVariance,
        priceVarianceCents,
      };
    }
  }
  return { status: 'matched', qtyVariance, priceVarianceCents };
}

/**
 * Roll up per-line statuses into a single bill-level verdict:
 *   - all `matched` (or `unmatched` with no PO ref) → 'matched'
 *   - any qty_mismatch / price_mismatch → 'unmatched' (needs override)
 *
 * The bill-level status governs whether posting requires `overrideMatchBy`.
 */
export function rollupBillMatch(
  lineResults: LineMatchResult[],
): 'matched' | 'unmatched' {
  const hasMismatch = lineResults.some(
    (r) => r.status === 'qty_mismatch' || r.status === 'price_mismatch',
  );
  return hasMismatch ? 'unmatched' : 'matched';
}
