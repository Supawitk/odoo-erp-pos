/**
 * 🇹🇭 Excise tax (พ.ร.บ.ภาษีสรรพสามิต พ.ศ. 2560 / Excise Act B.E. 2560).
 *
 * Computed BEFORE VAT. Excise + product cost = VAT base. Three product types
 * are common at Thai retail POS: alcohol, tobacco, sugar drinks.
 *
 * Rates pinned 2026-04-27 from Phase 3 Pre-Phase Research Log:
 *
 *   Alcohol (Lexology HoReC reform 2024, current 2026):
 *     wine               ฿1,000/L pure alcohol  + 5%  ad valorem
 *     spirits >7% ABV    ฿255/L pure alcohol    + 10% ad valorem
 *     traditional ≤7%    ฿150/L pure alcohol    + 0%
 *
 *   Tobacco (SEATCA 2025, unchanged 2026):
 *     pack ≤฿72          ฿1.25/stick  + 25% ad valorem
 *     pack >฿72          ฿1.25/stick  + 42% ad valorem
 *
 *   Sugar drinks (Phase 4 final live 1 Apr 2026, Bangkok Post):
 *     ≤6 g/100ml         exempt
 *     6–8 g/100ml        ฿1/L
 *     8–10 g/100ml       ฿3/L
 *     10–14 g/100ml      ฿5/L
 *     14–18 g/100ml      ฿5/L
 *     ≥18 g/100ml        ฿5/L
 *
 * Conventions:
 *   - All money returns are **cents/satang** (integer).
 *   - Volumes in `volumeMl` (integer ml).
 *   - ABV in basis points (`abvBp`): 700 = 7.00%.
 *   - Sugar density in g per 100 ml (`sugarGPer100ml`).
 *   - Quantity is line qty (integer for whole units; the engine itself
 *     doesn't care about units — qty * volumeMl gives total ml etc).
 */

export type ExciseCategory =
  | 'alcohol_wine'
  | 'alcohol_spirits_high' // >7% ABV
  | 'alcohol_spirits_low' // ≤7% ABV (traditional)
  | 'tobacco_low' // pack ≤฿72
  | 'tobacco_high' // pack >฿72
  | 'sugar';

export interface ExciseProduct {
  category: ExciseCategory | null;
  /** Specific rate, satang per unit. Optional override; otherwise looked up by category. */
  exciseSpecificCentsPerUnit?: number | null;
  /** Ad valorem rate in basis points (500 = 5%). Optional override. */
  exciseAdValoremBp?: number | null;
  /** For sugar: g sugar per 100 ml. Drives band lookup. */
  sugarGPer100ml?: number | null;
  /** For per-litre / per-stick math. */
  volumeMl?: number | null;
  /** Alcohol by volume in basis points (700 = 7.00%). */
  abvBp?: number | null;
}

export interface ExciseInput {
  product: ExciseProduct;
  /** Line qty (number of units). For tobacco this is sticks if you want per-stick math; pack if per-pack. */
  qty: number;
  /** Pre-excise price per unit, in satang. Used for ad-valorem. */
  unitPriceCents: number;
}

export interface ExciseResult {
  /** Total excise satang for this line (specific + ad valorem). */
  exciseCents: number;
  /** Specific component (qty-based). */
  specificCents: number;
  /** Ad valorem component (price-based). */
  adValoremCents: number;
  /** Why nothing was charged (when exciseCents=0): 'no_category' | 'sugar_band_exempt' | null. */
  reason: string | null;
}

/** Sugar-tax bands (2026 final phase, ฿/L). */
const SUGAR_BANDS: Array<{ maxG: number; centsPerLitre: number }> = [
  { maxG: 6, centsPerLitre: 0 },     // exempt
  { maxG: 8, centsPerLitre: 100 },   // ฿1
  { maxG: 10, centsPerLitre: 300 },  // ฿3
  { maxG: 14, centsPerLitre: 500 },  // ฿5
  { maxG: 18, centsPerLitre: 500 },  // ฿5
  { maxG: Infinity, centsPerLitre: 500 }, // ฿5
];

/** Pure-alcohol-litre specific rates per category, satang/L. */
const ALCOHOL_RATES: Partial<Record<ExciseCategory, number>> = {
  alcohol_wine: 100_000, // ฿1,000/L pure alcohol = 100,000 satang
  alcohol_spirits_high: 25_500,
  alcohol_spirits_low: 15_000,
};

/** Tobacco specific rate (per stick), satang. */
const TOBACCO_PER_STICK_CENTS = 125; // ฿1.25/stick

/** Default ad-valorem rates by category, basis points. */
const DEFAULT_AD_VALOREM_BP: Partial<Record<ExciseCategory, number>> = {
  alcohol_wine: 500, // 5%
  alcohol_spirits_high: 1000, // 10%
  alcohol_spirits_low: 0,
  tobacco_low: 2500, // 25%
  tobacco_high: 4200, // 42%
  sugar: 0,
};

/**
 * Compute excise for a single line. Pure function; no DB / no IO.
 * Returns 0 cents when product has no excise category.
 */
export function computeExcise(input: ExciseInput): ExciseResult {
  const { product, qty, unitPriceCents } = input;
  if (!product.category) {
    return { exciseCents: 0, specificCents: 0, adValoremCents: 0, reason: 'no_category' };
  }

  let specificCents = 0;
  let reason: string | null = null;

  switch (product.category) {
    case 'alcohol_wine':
    case 'alcohol_spirits_high':
    case 'alcohol_spirits_low': {
      // Specific rate is satang per LITRE OF PURE ALCOHOL.
      // PureAlcoholLitres(line) = qty * volumeMl/1000 * abvBp/10000
      const ratePerL = product.exciseSpecificCentsPerUnit ?? ALCOHOL_RATES[product.category] ?? 0;
      const volumeMl = product.volumeMl ?? 0;
      const abvBp = product.abvBp ?? 0;
      const pureAlcoholLitres = (qty * volumeMl * abvBp) / (1000 * 10000);
      specificCents = Math.round(pureAlcoholLitres * ratePerL);
      break;
    }
    case 'tobacco_low':
    case 'tobacco_high': {
      // Specific = ฿1.25/stick × qty (interpret qty as sticks).
      const perStick = product.exciseSpecificCentsPerUnit ?? TOBACCO_PER_STICK_CENTS;
      specificCents = qty * perStick;
      break;
    }
    case 'sugar': {
      // Specific = band(g/100ml) × volumeMl/1000 × qty
      const sugarG = product.sugarGPer100ml ?? 0;
      const band = SUGAR_BANDS.find((b) => sugarG <= b.maxG) ?? SUGAR_BANDS[SUGAR_BANDS.length - 1];
      if (band.centsPerLitre === 0) {
        reason = 'sugar_band_exempt';
        specificCents = 0;
      } else {
        const volumeMl = product.volumeMl ?? 0;
        specificCents = Math.round((qty * volumeMl * band.centsPerLitre) / 1000);
      }
      break;
    }
  }

  const adValoremBp = product.exciseAdValoremBp ?? DEFAULT_AD_VALOREM_BP[product.category] ?? 0;
  const adValoremCents = Math.round((qty * unitPriceCents * adValoremBp) / 10000);

  return {
    exciseCents: specificCents + adValoremCents,
    specificCents,
    adValoremCents,
    reason,
  };
}

/** Look up the sugar-tax band applicable to a given sugar density (g/100ml). */
export function sugarBand(sugarGPer100ml: number): { maxG: number; centsPerLitre: number } {
  return (
    SUGAR_BANDS.find((b) => sugarGPer100ml <= b.maxG) ??
    SUGAR_BANDS[SUGAR_BANDS.length - 1]
  );
}
