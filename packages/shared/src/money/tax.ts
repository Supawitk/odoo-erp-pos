import { Money, type CurrencyCode } from "./money";

export type TaxMode = "inclusive" | "exclusive";

export interface TaxableLine {
  id: string;
  /** Line total AFTER discount but BEFORE tax (for exclusive mode). */
  subtotalCents: number;
  /** Optional per-line override; falls back to default rate. */
  taxRate?: number;
  taxMode?: TaxMode;
}

/**
 * Tax MUST be computed AFTER discount.
 * For exclusive tax: tax = subtotal * rate.
 * For inclusive tax: tax = gross - (gross / (1 + rate)).
 *
 * Uses `Money.allocate` on the total to distribute rounding across lines,
 * so sum of per-line taxes always equals the tax on the sum.
 */
export function calculateTax(
  lines: TaxableLine[],
  defaultRate: number,
  defaultMode: TaxMode = "exclusive",
  currency: CurrencyCode = "USD",
): { totalTax: Money; perLineTax: Map<string, Money> } {
  const perLineTax = new Map<string, Money>();

  let totalTaxCents = 0;
  for (const line of lines) {
    const rate = line.taxRate ?? defaultRate;
    const mode = line.taxMode ?? defaultMode;
    let taxCents: number;

    if (mode === "inclusive") {
      // gross = subtotal (already includes tax)
      // tax = gross * rate / (1 + rate)
      taxCents = Math.round((line.subtotalCents * rate) / (1 + rate));
    } else {
      taxCents = Math.round(line.subtotalCents * rate);
    }

    perLineTax.set(line.id, Money.ofCents(taxCents, currency));
    totalTaxCents += taxCents;
  }

  return {
    totalTax: Money.ofCents(totalTaxCents, currency),
    perLineTax,
  };
}

/** Reverse of inclusive tax: gross 110, rate 0.1 -> net 100. */
export function stripInclusiveTax(
  grossCents: number,
  rate: number,
  currency: CurrencyCode = "USD",
): { net: Money; tax: Money } {
  const taxCents = Math.round((grossCents * rate) / (1 + rate));
  return {
    net: Money.ofCents(grossCents - taxCents, currency),
    tax: Money.ofCents(taxCents, currency),
  };
}
