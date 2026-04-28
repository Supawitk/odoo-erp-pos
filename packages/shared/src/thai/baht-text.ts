/**
 * Convert a THB amount to Thai words ("บาทถ้วน" format), as required on
 * full tax invoices and many receipts by RD convention.
 *
 * Examples:
 *   0         → ศูนย์บาทถ้วน
 *   1         → หนึ่งบาทถ้วน
 *   21        → ยี่สิบเอ็ดบาทถ้วน
 *   100       → หนึ่งร้อยบาทถ้วน
 *   1234.56   → หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบหกสตางค์
 *   1000000   → หนึ่งล้านบาทถ้วน
 *
 * Accepts either baht-as-decimal (number) or satang-as-integer (bigint safe).
 */

const DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/** Convert an integer 0..999_999 to its Thai word form (no trailing บาท). */
function convertSixDigits(n: number): string {
  if (n === 0) return DIGITS[0];

  const digits = String(n).split("").map(Number);
  const len = digits.length;
  let out = "";

  for (let i = 0; i < len; i += 1) {
    const d = digits[i];
    const placeIdx = len - 1 - i;

    if (d === 0) continue;

    if (placeIdx === 0) {
      // Ones place — final digit
      if (d === 1 && len > 1) out += "เอ็ด";
      else out += DIGITS[d];
    } else if (placeIdx === 1) {
      // Tens place
      if (d === 1) out += "สิบ";
      else if (d === 2) out += "ยี่สิบ";
      else out += DIGITS[d] + "สิบ";
    } else {
      out += DIGITS[d] + PLACES[placeIdx];
    }
  }

  return out;
}

function convertWholeBaht(whole: number): string {
  if (whole === 0) return DIGITS[0];

  // Split into groups of 6 digits (ล้าน chunks)
  const parts: string[] = [];
  let remaining = whole;
  while (remaining > 0) {
    parts.unshift(String(remaining % 1_000_000));
    remaining = Math.floor(remaining / 1_000_000);
  }

  let out = "";
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = Number(parts[i]);
    const remainingLevels = parts.length - 1 - i;

    if (chunk === 0) continue;

    // Special case: for non-final chunks where chunk is small, keep full form.
    out += convertSixDigits(chunk);
    if (remainingLevels > 0) {
      out += "ล้าน".repeat(remainingLevels);
    }
  }

  return out || DIGITS[0];
}

export function bahtText(amountBaht: number): string {
  if (!Number.isFinite(amountBaht)) throw new Error("bahtText requires a finite number");
  const negative = amountBaht < 0;
  const abs = Math.abs(amountBaht);

  // Work in satang to avoid float drift.
  const satang = Math.round(abs * 100);
  const whole = Math.floor(satang / 100);
  const fractional = satang % 100;

  const wholePart = convertWholeBaht(whole);
  let out: string;
  if (fractional === 0) {
    out = `${wholePart}บาทถ้วน`;
  } else {
    out = `${wholePart}บาท${convertSixDigits(fractional)}สตางค์`;
  }
  return negative ? `ลบ${out}` : out;
}

/** Same function but from satang integers — safer for financial code paths. */
export function bahtTextFromSatang(satang: number): string {
  if (!Number.isInteger(satang)) throw new Error("bahtTextFromSatang requires an integer");
  return bahtText(satang / 100);
}
