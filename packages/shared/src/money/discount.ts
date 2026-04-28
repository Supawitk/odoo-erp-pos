import { Money, type CurrencyCode } from "./money";

export type DiscountKind = "line-monetary" | "line-percent" | "cart-monetary" | "cart-percent";

export interface Discount {
  id: string;
  kind: DiscountKind;
  /** For percent: 0.1 = 10%. For monetary: amount in cents. */
  value: number;
  /** Which line this applies to (line-* only). Undefined for cart-*. */
  lineId?: string;
  description?: string;
}

const PRIORITY: Record<DiscountKind, number> = {
  "line-monetary": 1,
  "line-percent": 2,
  "cart-monetary": 3,
  "cart-percent": 4,
};

export interface DiscountInput {
  id: string;
  subtotalCents: number;
}

export interface DiscountResult {
  /** Net subtotal per line after discount (never below zero). */
  perLineNet: Map<string, Money>;
  /** Total discount amount applied. */
  totalDiscount: Money;
}

/**
 * Apply discounts in priority order: line-monetary -> line-percent -> cart-monetary -> cart-percent.
 * Cart-level discounts are prorated across lines using Money.allocate (rounding-safe).
 * Line net can never go below zero.
 */
export function applyDiscounts(
  lines: DiscountInput[],
  discounts: Discount[],
  currency: CurrencyCode = "USD",
): DiscountResult {
  const perLineNet = new Map<string, Money>();
  for (const l of lines) {
    perLineNet.set(l.id, Money.ofCents(l.subtotalCents, currency));
  }

  const sorted = [...discounts].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);

  for (const discount of sorted) {
    if (discount.kind === "line-monetary" || discount.kind === "line-percent") {
      const lineId = discount.lineId;
      if (!lineId) continue;
      const current = perLineNet.get(lineId);
      if (!current) continue;

      const reduction =
        discount.kind === "line-monetary"
          ? Money.ofCents(discount.value, currency)
          : current.multiply(discount.value);

      const next = current.subtract(reduction);
      perLineNet.set(lineId, next.isNegative() ? Money.zero(currency) : next);
    } else {
      // cart-level: prorate across all lines by their current net
      const totals = Array.from(perLineNet.values());
      const cartTotal = totals.reduce((a, b) => a.add(b), Money.zero(currency));
      if (cartTotal.isZero()) continue;

      const reduction =
        discount.kind === "cart-monetary"
          ? Money.ofCents(Math.min(discount.value, cartTotal.toCents()), currency)
          : cartTotal.multiply(discount.value);

      const ratios = Array.from(perLineNet.values()).map((m) => m.toCents());
      const ids = Array.from(perLineNet.keys());
      const distributed = reduction.allocate(ratios);

      ids.forEach((id, i) => {
        const current = perLineNet.get(id)!;
        const next = current.subtract(distributed[i]);
        perLineNet.set(id, next.isNegative() ? Money.zero(currency) : next);
      });
    }
  }

  const originalTotal = lines.reduce(
    (sum, l) => sum.add(Money.ofCents(l.subtotalCents, currency)),
    Money.zero(currency),
  );
  const netTotal = Array.from(perLineNet.values()).reduce(
    (a, b) => a.add(b),
    Money.zero(currency),
  );

  return {
    perLineNet,
    totalDiscount: originalTotal.subtract(netTotal),
  };
}
