/**
 * Thai Tax Identification Number (TIN / เลขประจำตัวผู้เสียภาษี).
 *
 * Individuals use their 13-digit citizen ID; juristic persons use the 13-digit
 * company registration number. Both share the same mod-11 checksum algorithm
 * defined by the Revenue Department.
 *
 * Algorithm (positions 1..13, left-to-right, 1-indexed):
 *   sum = Σ (digit[i] * (14 - i))   for i in 1..12
 *   checksum = (11 - (sum mod 11)) mod 10
 *   valid iff checksum == digit[13]
 */

const DIGITS_ONLY = /^\d{13}$/;

export type TINKind = "citizen" | "juristic";

export interface TINInfo {
  tin: string;
  kind: TINKind;
  /** Branch code, 5 digits, defaults to "00000" (head office). */
  branch: string;
}

/** Strip spaces, dashes, commas so "1-2345-67890-12-3" normalises cleanly. */
export function normalizeTIN(raw: string): string {
  return raw.replace(/[\s\-.,]/g, "");
}

export function isValidTIN(raw: string): boolean {
  const tin = normalizeTIN(raw);
  if (!DIGITS_ONLY.test(tin)) return false;

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(tin[i]) * (13 - i);
  }
  const checksum = (11 - (sum % 11)) % 10;
  return checksum === Number(tin[12]);
}

/** Thai branch code: 5 digits, "00000" == head office. */
export function isValidBranchCode(raw: string): boolean {
  return /^\d{5}$/.test(raw);
}

/**
 * Heuristic kind detection. The RD's citizen-ID scheme uses 1/2/3/4/5/6/7/8 as
 * the leading digit (card type); juristic registration numbers start with 0.
 * This is advisory only — callers should not *enforce* kind from the leading
 * digit alone because the checksum is identical in both ranges.
 */
export function guessTINKind(raw: string): TINKind {
  const tin = normalizeTIN(raw);
  return tin.startsWith("0") ? "juristic" : "citizen";
}

/** Parse + validate; throws with a specific reason. */
export function parseTIN(raw: string, branchRaw?: string): TINInfo {
  const tin = normalizeTIN(raw);
  if (!DIGITS_ONLY.test(tin)) {
    throw new Error(`TIN must be 13 digits, got "${raw}"`);
  }
  if (!isValidTIN(tin)) {
    throw new Error(`TIN checksum invalid: ${tin}`);
  }
  const branch = branchRaw ? branchRaw.padStart(5, "0") : "00000";
  if (!isValidBranchCode(branch)) {
    throw new Error(`Branch code must be 5 digits, got "${branchRaw}"`);
  }
  return { tin, kind: guessTINKind(tin), branch };
}

/** Formatting helper: "1-2345-67890-12-3" (RD display convention). */
export function formatTIN(raw: string): string {
  const tin = normalizeTIN(raw);
  if (!DIGITS_ONLY.test(tin)) return raw;
  return `${tin[0]}-${tin.slice(1, 5)}-${tin.slice(5, 10)}-${tin.slice(10, 12)}-${tin[12]}`;
}
