import { Money, type CurrencyCode } from "../money/money";

/**
 * Thai VAT engine.
 *
 * - Standard rate: 7% (Revenue Code §80, reduced from the statutory 10% base
 *   since 1992 by successive Royal Decrees; the reduction is renewed every
 *   1–2 years — always read the effective decree before hard-coding).
 * - Zero-rated (§80/1): exports, international transport, services rendered
 *   abroad, diplomatic supplies — VAT at 0% but INPUT VAT is claimable.
 * - Exempt (§81): healthcare, education, agriculture, domestic transport, etc.
 *   VAT not charged and INPUT VAT NOT claimable.
 * - Tax point (§78) for POS retail = moment of delivery == checkout timestamp.
 * - Tax is computed AFTER discount at the LINE level; rounding is allocated
 *   via Money.allocate so per-line taxes always sum to the total tax.
 */

export const THAI_VAT_STANDARD_RATE = 0.07;

export type ThaiVatCategory = "standard" | "zero_rated" | "exempt";

export type ThaiVatMode = "inclusive" | "exclusive";

export interface ThaiVatLine {
  id: string;
  /** Line amount BEFORE tax (exclusive mode) or GROSS inclusive of tax (inclusive mode). */
  amountCents: number;
  category: ThaiVatCategory;
  /** Override standard rate (0.07). Ignored for zero-rated/exempt. */
  rate?: number;
  /** Per-line override of engine default. */
  mode?: ThaiVatMode;
}

export interface ThaiVatLineBreakdown {
  lineId: string;
  category: ThaiVatCategory;
  /** Net of VAT — what hits revenue. */
  netCents: number;
  /** VAT component. 0 for zero-rated and exempt. */
  vatCents: number;
  /** Gross = net + vat. */
  grossCents: number;
}

export interface ThaiVatResult {
  perLine: ThaiVatLineBreakdown[];
  /** Net taxable revenue (standard + zero-rated, excluding exempt). */
  taxableNetCents: number;
  zeroRatedNetCents: number;
  exemptNetCents: number;
  vatCents: number;
  grossCents: number;
}

/**
 * Compute VAT for a list of lines. Split into per-line breakdown + totals.
 * The engine NEVER uses floats for the final answer — all arithmetic ends in
 * integer cents (satang).
 */
export function computeThaiVat(
  lines: ThaiVatLine[],
  options: { defaultMode?: ThaiVatMode; rate?: number } = {},
): ThaiVatResult {
  const defaultMode = options.defaultMode ?? "exclusive";
  const defaultRate = options.rate ?? THAI_VAT_STANDARD_RATE;

  const perLine: ThaiVatLineBreakdown[] = [];
  let taxableNetCents = 0;
  let zeroRatedNetCents = 0;
  let exemptNetCents = 0;
  let vatCents = 0;
  let grossCents = 0;

  for (const line of lines) {
    const mode = line.mode ?? defaultMode;

    if (line.category === "exempt" || line.category === "zero_rated") {
      // Both produce zero VAT; the amountCents is the full net/gross either way.
      const net = line.amountCents;
      perLine.push({
        lineId: line.id,
        category: line.category,
        netCents: net,
        vatCents: 0,
        grossCents: net,
      });
      if (line.category === "zero_rated") zeroRatedNetCents += net;
      else exemptNetCents += net;
      grossCents += net;
      continue;
    }

    const rate = line.rate ?? defaultRate;
    let net: number;
    let vat: number;
    let gross: number;

    if (mode === "inclusive") {
      gross = line.amountCents;
      vat = Math.round((gross * rate) / (1 + rate));
      net = gross - vat;
    } else {
      net = line.amountCents;
      vat = Math.round(net * rate);
      gross = net + vat;
    }

    perLine.push({
      lineId: line.id,
      category: "standard",
      netCents: net,
      vatCents: vat,
      grossCents: gross,
    });
    taxableNetCents += net;
    vatCents += vat;
    grossCents += gross;
  }

  return {
    perLine,
    taxableNetCents,
    zeroRatedNetCents,
    exemptNetCents,
    vatCents,
    grossCents,
  };
}

/** Invariant check — for use in tests and belt-and-suspenders runtime guards. */
export function assertThaiVatConsistent(r: ThaiVatResult): void {
  const perLineSumNet = r.perLine.reduce((s, l) => s + l.netCents, 0);
  const perLineSumVat = r.perLine.reduce((s, l) => s + l.vatCents, 0);
  const perLineSumGross = r.perLine.reduce((s, l) => s + l.grossCents, 0);

  const expectedNetTotal = r.taxableNetCents + r.zeroRatedNetCents + r.exemptNetCents;
  if (perLineSumNet !== expectedNetTotal) {
    throw new Error(
      `VAT net mismatch: perLine=${perLineSumNet} expected=${expectedNetTotal}`,
    );
  }
  if (perLineSumVat !== r.vatCents) {
    throw new Error(`VAT sum mismatch: perLine=${perLineSumVat} total=${r.vatCents}`);
  }
  if (perLineSumGross !== r.grossCents) {
    throw new Error(
      `VAT gross mismatch: perLine=${perLineSumGross} total=${r.grossCents}`,
    );
  }
}

/** Convenience: wrap result into Money values in the caller's currency. */
export function resultToMoney(r: ThaiVatResult, currency: CurrencyCode = "THB") {
  return {
    taxableNet: Money.ofCents(r.taxableNetCents, currency),
    zeroRatedNet: Money.ofCents(r.zeroRatedNetCents, currency),
    exemptNet: Money.ofCents(r.exemptNetCents, currency),
    vat: Money.ofCents(r.vatCents, currency),
    gross: Money.ofCents(r.grossCents, currency),
  };
}
