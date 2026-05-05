/**
 * 🇹🇭 §65 ter — Thai Revenue Code non-deductible expense register.
 *
 * Categories implemented (the ones SMEs actually hit):
 *   entertainment_over_cap   §65 ter (4)  — entertainment > 0.3% cap
 *   personal                 §65 ter (3)  — personal/family expenses
 *   capital_expensed         §65 ter (2)  — capex booked to expense
 *   donations_over_cap       §65 ter (3)/(b) §3(18ทวิ) — beyond cap
 *   fines_penalties          §65 ter (6)  — always 100% non-deductible
 *   cit_self                 §65 ter (6)  — CIT itself (account 9110)
 *   reserves_provisions      §65 ter (1)  — bad-debt + general reserves
 *   non_business             §65 ter (10) — non-business purpose
 *   excessive_depreciation   §65 ter (13) — over the legal rate
 *   undocumented             §65 ter (14) — no supporting docs
 *   foreign_overhead         §65 ter (17) — primarily for foreign cos
 *   other                    catch-all for §65 ter (18)/(19)/(20)/etc.
 *
 * The register is computed PER FISCAL PERIOD — on PND.50 / PND.51 we add
 * the period's non-deductible total back to taxable income before the
 * bracket calc.
 *
 * Cap rules:
 *   Entertainment (§65 ter (4) + Royal Decree 437/2548):
 *     deductible = max(0.3% × revenue, 0.3% × paid-in capital), max ฿10M.
 *     anything over → flagged.
 *
 *   Donations (§65 ter (3)(b) + §3(18ทวิ)):
 *     general charity        ≤ 2% of net profit BEFORE donation deduction
 *     designated education   ≤ 2% of net profit (separate bucket, same calc)
 *     anything over → flagged.
 */

export const NON_DEDUCTIBLE_CATEGORIES = [
  'entertainment_over_cap',
  'personal',
  'capital_expensed',
  'donations_over_cap',
  'fines_penalties',
  'cit_self',
  'reserves_provisions',
  'non_business',
  'excessive_depreciation',
  'undocumented',
  'foreign_overhead',
  'other',
] as const;

export type NonDeductibleCategory = (typeof NON_DEDUCTIBLE_CATEGORIES)[number];

export const CATEGORY_LABELS_TH: Record<NonDeductibleCategory, string> = {
  entertainment_over_cap: 'ค่ารับรองเกินอัตรา (§65 ตรี (4))',
  personal: 'รายจ่ายส่วนตัว (§65 ตรี (3))',
  capital_expensed: 'รายจ่ายอันมีลักษณะเป็นการลงทุน (§65 ตรี (2))',
  donations_over_cap: 'เงินบริจาคเกินกำหนด (§65 ตรี (3)(b))',
  fines_penalties: 'เบี้ยปรับ/เงินเพิ่ม (§65 ตรี (6))',
  cit_self: 'ภาษีเงินได้นิติบุคคล (§65 ตรี (6))',
  reserves_provisions: 'เงินสำรอง/ค่าเผื่อ (§65 ตรี (1))',
  non_business: 'รายจ่ายที่มิใช่ธุรกิจ (§65 ตรี (10))',
  excessive_depreciation: 'ค่าเสื่อมเกินอัตรา (§65 ตรี (13))',
  undocumented: 'รายจ่ายไม่มีใบเสร็จ (§65 ตรี (14))',
  foreign_overhead: 'รายจ่ายของบริษัทต่างประเทศ (§65 ตรี (17))',
  other: 'อื่น ๆ',
};

export const CATEGORY_LABELS_EN: Record<NonDeductibleCategory, string> = {
  entertainment_over_cap: 'Entertainment over cap (§65 ter (4))',
  personal: 'Personal expenses (§65 ter (3))',
  capital_expensed: 'Capex booked as expense (§65 ter (2))',
  donations_over_cap: 'Donations over cap (§65 ter (3)(b))',
  fines_penalties: 'Fines & penalties (§65 ter (6))',
  cit_self: 'Corporate income tax itself (§65 ter (6))',
  reserves_provisions: 'Reserves / provisions (§65 ter (1))',
  non_business: 'Non-business expenses (§65 ter (10))',
  excessive_depreciation: 'Excessive depreciation (§65 ter (13))',
  undocumented: 'Undocumented expenses (§65 ter (14))',
  foreign_overhead: 'Foreign-co overhead (§65 ter (17))',
  other: 'Other',
};

export interface CapMath {
  /** What the §65 ter cap allows for this category in this period. */
  capCents: number;
  /** What was actually spent in the period. */
  spentCents: number;
  /** How much is non-deductible (= max(spent − cap, 0)). */
  overCapCents: number;
  /** Verbose explanation of the cap source — useful for the UI. */
  reason: string;
}

const ENTERTAINMENT_HARD_CAP_CENTS = 1_000_000_000; // ฿10M
const ENTERTAINMENT_RATE_BP = 30; // 0.30%
const DONATION_RATE_BP = 200; // 2.00% of net profit before donations

/**
 * §65 ter (4) entertainment cap:
 *   max(0.3% × revenue, 0.3% × paid-in capital), absolute ฿10M ceiling.
 */
export function entertainmentCap(input: {
  annualRevenueCents: number;
  paidInCapitalCents: number;
  actualEntertainmentCents: number;
}): CapMath {
  const fromRevenue = Math.floor((input.annualRevenueCents * ENTERTAINMENT_RATE_BP) / 10_000);
  const fromCapital = Math.floor((input.paidInCapitalCents * ENTERTAINMENT_RATE_BP) / 10_000);
  const higherBasis = Math.max(fromRevenue, fromCapital);
  const cap = Math.min(higherBasis, ENTERTAINMENT_HARD_CAP_CENTS);
  const overCap = Math.max(0, input.actualEntertainmentCents - cap);
  const basisLabel =
    fromRevenue >= fromCapital
      ? `0.3% × revenue (฿${(input.annualRevenueCents / 100).toLocaleString()})`
      : `0.3% × paid-in capital (฿${(input.paidInCapitalCents / 100).toLocaleString()})`;
  const reason =
    cap === ENTERTAINMENT_HARD_CAP_CENTS && higherBasis > ENTERTAINMENT_HARD_CAP_CENTS
      ? `${basisLabel} would be ฿${(higherBasis / 100).toLocaleString()}, but ฿10M absolute ceiling applies`
      : basisLabel;
  return { capCents: cap, spentCents: input.actualEntertainmentCents, overCapCents: overCap, reason };
}

/**
 * §65 ter (3)(b) donation cap:
 *   2% of net profit BEFORE the donation deduction.
 *
 * Net profit before donation = revenue − (expense − donations)
 *                            = revenue − expense + donations
 * So adding back the donation amount itself.
 */
export function donationCap(input: {
  revenueCents: number;
  expenseCents: number;
  actualDonationsCents: number;
}): CapMath {
  // "before donation deduction" = profit + donations (since donations are in expense already).
  const profitBeforeDonation = input.revenueCents - input.expenseCents + input.actualDonationsCents;
  const capRaw = Math.floor((Math.max(0, profitBeforeDonation) * DONATION_RATE_BP) / 10_000);
  const overCap = Math.max(0, input.actualDonationsCents - capRaw);
  return {
    capCents: capRaw,
    spentCents: input.actualDonationsCents,
    overCapCents: overCap,
    reason: `2% × net profit before donation (฿${(profitBeforeDonation / 100).toLocaleString()})`,
  };
}

/**
 * Aggregate flagged amounts by category. Used by the register endpoint.
 */
export function summariseByCategory(
  rows: Array<{ category: NonDeductibleCategory; cents: number }>,
): { byCategory: Record<NonDeductibleCategory, number>; totalCents: number } {
  const byCategory = Object.fromEntries(
    NON_DEDUCTIBLE_CATEGORIES.map((c) => [c, 0]),
  ) as Record<NonDeductibleCategory, number>;
  let total = 0;
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.cents;
    total += r.cents;
  }
  return { byCategory, totalCents: total };
}

/**
 * Validate a category string from API input. Returns the typed value or null.
 */
export function parseCategory(s: unknown): NonDeductibleCategory | null {
  if (typeof s !== 'string') return null;
  return (NON_DEDUCTIBLE_CATEGORIES as readonly string[]).includes(s)
    ? (s as NonDeductibleCategory)
    : null;
}
