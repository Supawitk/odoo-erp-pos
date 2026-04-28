import {
  THAI_VAT_STANDARD_RATE,
  computeThaiVat,
  type ThaiVatCategory,
  type ThaiVatMode,
  type ThaiVatResult,
} from '@erp/shared';
import type { OrderLineData, VatBreakdown } from './order.entity';

export interface PricingInput {
  lines: OrderLineData[];
  cartDiscountCents: number;
  vatMode: ThaiVatMode;
  vatRate: number;
}

export interface PricingResult {
  lines: OrderLineData[]; // enriched with netCents/vatCents/grossCents
  subtotalCents: number; // sum of net before discount
  discountCents: number; // total discount applied (line + cart)
  taxCents: number; // VAT total
  totalCents: number; // grand total payable
  vatBreakdown: VatBreakdown;
}

/**
 * Compute all the money for an order.
 *
 * Order of operations per Revenue Code §79 + departmental practice:
 *   1. Per-line amount = qty × unitPrice
 *   2. Apply per-line discount
 *   3. Apply cart-level discount pro-rated across taxable lines by net ratio
 *      (standard + zero-rated — exempt lines are left alone by convention so
 *      discounts don't cross a VAT category boundary)
 *   4. Run VAT engine in the merchant's mode
 *   5. Sum to grand total
 */
export function priceOrder(input: PricingInput): PricingResult {
  const rate = input.vatRate ?? THAI_VAT_STANDARD_RATE;
  const mode = input.vatMode;

  // Step 1 + 2 — gross per line after own discount, plus 🇹🇭 excise added BEFORE VAT.
  const stage1 = input.lines.map((line) => {
    const gross = line.qty * line.unitPriceCents;
    const perLineDiscount = Math.min(line.discountCents ?? 0, gross);
    const afterLineDiscount = gross - perLineDiscount;
    const excise = Math.max(0, line.exciseCents ?? 0);
    return {
      line,
      category: (line.vatCategory ?? 'standard') as ThaiVatCategory,
      afterLineDiscount,
      perLineDiscount,
      exciseCents: excise,
    };
  });

  // Step 3 — pro-rate cart discount across taxable + zero-rated lines.
  const cartDiscount = Math.max(0, input.cartDiscountCents);
  const eligibleBaseCents = stage1
    .filter((s) => s.category !== 'exempt')
    .reduce((sum, s) => sum + s.afterLineDiscount, 0);

  const stage2 = stage1.map((s) => {
    // amountForVat = post-discount price + excise, with cart discount applied later.
    if (cartDiscount === 0 || eligibleBaseCents === 0 || s.category === 'exempt') {
      return { ...s, cartShare: 0, amountForVat: s.afterLineDiscount + s.exciseCents };
    }
    const share = Math.round((cartDiscount * s.afterLineDiscount) / eligibleBaseCents);
    return { ...s, cartShare: share, amountForVat: s.afterLineDiscount + s.exciseCents - share };
  });

  // Correct tiny rounding drift: redirect remainder to the largest-share line.
  const distributedCart = stage2.reduce((sum, s) => sum + s.cartShare, 0);
  const cartDrift = cartDiscount - distributedCart;
  if (cartDrift !== 0 && stage2.length > 0) {
    const largest = stage2.reduce((a, b) => (b.cartShare > a.cartShare ? b : a));
    largest.cartShare += cartDrift;
    largest.amountForVat -= cartDrift;
  }

  // Step 4 — VAT.
  const vat: ThaiVatResult = computeThaiVat(
    stage2.map((s, i) => ({
      id: String(i),
      amountCents: s.amountForVat,
      category: s.category,
    })),
    { defaultMode: mode, rate },
  );

  // Stitch per-line breakdown back onto original lines (preserve excise echo).
  const enrichedLines: OrderLineData[] = stage2.map((s, i) => {
    const breakdown = vat.perLine[i];
    return {
      ...s.line,
      discountCents: (s.line.discountCents ?? 0) + s.cartShare,
      exciseCents: s.exciseCents || undefined,
      netCents: breakdown.netCents,
      vatCents: breakdown.vatCents,
      grossCents: breakdown.grossCents,
    };
  });

  const subtotalCents = stage1.reduce((sum, s) => sum + s.afterLineDiscount + s.perLineDiscount, 0);
  const discountCents =
    stage2.reduce((sum, s) => sum + s.perLineDiscount + s.cartShare, 0);
  const exciseCentsTotal = stage1.reduce((sum, s) => sum + s.exciseCents, 0);
  const totalCents = vat.grossCents;

  return {
    lines: enrichedLines,
    subtotalCents,
    discountCents,
    taxCents: vat.vatCents,
    totalCents,
    vatBreakdown: {
      taxableNetCents: vat.taxableNetCents,
      zeroRatedNetCents: vat.zeroRatedNetCents,
      exemptNetCents: vat.exemptNetCents,
      vatCents: vat.vatCents,
      grossCents: vat.grossCents,
      exciseCents: exciseCentsTotal || undefined,
    },
  };
}
