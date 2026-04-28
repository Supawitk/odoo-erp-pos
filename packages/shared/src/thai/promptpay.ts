/**
 * PromptPay QR payload generator (EMVCo QR Code Specification for Payment
 * Systems — Merchant-Presented Mode, Thai QR national profile).
 *
 * Supports two flavours:
 *   1. Person-to-person / merchant (tag 29, GUID A000000677010111)
 *      — target = phone, citizen ID, or e-wallet.
 *   2. Bill payment (tag 30, GUID A000000677010112)
 *      — 15-digit Biller ID + Ref1 (order ID) + optional Ref2 (terminal/session).
 *
 * Dynamic QR = amount present → POI method "12". Static QR = no amount → "11".
 *
 * Zero runtime dependencies. CRC16-CCITT (poly 0x1021, init 0xFFFF, xmodem
 * variant) is inlined.
 */

// ─── EMVCo top-level tag IDs ──────────────────────────────────────────────
const ID_PAYLOAD_FORMAT = "00";
const ID_POI_METHOD = "01";
const ID_MERCHANT_ACCOUNT_TAG29 = "29"; // person-to-person
const ID_MERCHANT_ACCOUNT_TAG30 = "30"; // bill-payment
const ID_TRANSACTION_CURRENCY = "53";
const ID_TRANSACTION_AMOUNT = "54";
const ID_COUNTRY_CODE = "58";
const ID_CRC = "63";

// ─── Sub-tags under tag 29 (person-to-person) ─────────────────────────────
const SUB_GUID = "00";
const SUB_PHONE = "01";
const SUB_TAX_ID = "02";
const SUB_EWALLET = "03";

// ─── Sub-tags under tag 30 (bill-payment) ─────────────────────────────────
const SUB_BILLER = "01";
const SUB_REF1 = "02";
const SUB_REF2 = "03";

// ─── Constants ────────────────────────────────────────────────────────────
const PAYLOAD_FORMAT_EMV = "01";
const POI_STATIC = "11";
const POI_DYNAMIC = "12";
const GUID_PROMPTPAY_P2P = "A000000677010111";
const GUID_PROMPTPAY_BILL = "A000000677010112";
const CURRENCY_THB = "764";
const COUNTRY_TH = "TH";

/** Encode a TLV triple: 2-char tag + 2-char length + value. */
function tlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  if (value.length > 99) {
    throw new Error(`TLV value too long for 2-digit length: tag ${tag}, ${value.length} chars`);
  }
  return tag + len + value;
}

function crc16CCITT(input: string): number {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function formatCrc(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function formatAmount(amountBaht: number): string {
  if (!Number.isFinite(amountBaht) || amountBaht <= 0) {
    throw new Error(`PromptPay amount must be a positive number of baht, got ${amountBaht}`);
  }
  return amountBaht.toFixed(2);
}

function formatPhoneOrId(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 13) return digits; // already citizen-ID or TIN-length
  // Thai mobile: normalise to country-code form, prefix 66, strip leading 0.
  const normalised = digits.replace(/^0/, "66");
  return normalised.padStart(13, "0");
}

// ─── Person-to-person / merchant-phone QR ────────────────────────────────
export interface PromptPayP2POptions {
  /** Merchant phone (10 digits), citizen ID / TIN (13), or e-wallet (15). */
  target: string;
  /** Amount in baht (e.g. 119.50). Omit for a static QR. */
  amountBaht?: number;
}

export function generatePromptPayP2P(opts: PromptPayP2POptions): string {
  const target = opts.target.replace(/\D/g, "");
  let subTag: string;
  let value: string;
  if (target.length >= 15) {
    subTag = SUB_EWALLET;
    value = target;
  } else if (target.length >= 13) {
    subTag = SUB_TAX_ID;
    value = target;
  } else {
    subTag = SUB_PHONE;
    value = formatPhoneOrId(target);
  }

  const merchantAccount = tlv(SUB_GUID, GUID_PROMPTPAY_P2P) + tlv(subTag, value);

  const parts = [
    tlv(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_EMV),
    tlv(ID_POI_METHOD, opts.amountBaht ? POI_DYNAMIC : POI_STATIC),
    tlv(ID_MERCHANT_ACCOUNT_TAG29, merchantAccount),
    tlv(ID_COUNTRY_CODE, COUNTRY_TH),
    tlv(ID_TRANSACTION_CURRENCY, CURRENCY_THB),
    opts.amountBaht ? tlv(ID_TRANSACTION_AMOUNT, formatAmount(opts.amountBaht)) : "",
  ].filter(Boolean);

  const core = parts.join("");
  const withCrcTag = core + ID_CRC + "04";
  const crc = formatCrc(crc16CCITT(withCrcTag));
  return core + tlv(ID_CRC, crc);
}

// ─── Bill-payment QR (tag 30, Ref1/Ref2) ─────────────────────────────────
export interface PromptPayBillOptions {
  /** 15-digit Biller ID (13-digit TIN + 2-digit suffix allocated by the bank). */
  billerId: string;
  /** Amount in baht. REQUIRED — bill-payment QRs are always dynamic. */
  amountBaht: number;
  /** Order reference. ASCII only. Upper-case recommended. Max 20 chars. */
  ref1: string;
  /** Secondary reference (terminal/session). Optional. Max 20 chars. */
  ref2?: string;
}

export function generatePromptPayBill(opts: PromptPayBillOptions): string {
  const biller = opts.billerId.replace(/\D/g, "");
  if (biller.length !== 15) {
    throw new Error(`Biller ID must be 15 digits (13-digit TIN + 2-digit suffix), got ${biller.length}`);
  }
  if (!/^[A-Za-z0-9]{1,20}$/.test(opts.ref1)) {
    throw new Error(`Ref1 must be 1–20 alphanumeric chars, got "${opts.ref1}"`);
  }
  if (opts.ref2 !== undefined && !/^[A-Za-z0-9]{1,20}$/.test(opts.ref2)) {
    throw new Error(`Ref2 must be 1–20 alphanumeric chars, got "${opts.ref2}"`);
  }

  const ref1Upper = opts.ref1.toUpperCase();
  const ref2Upper = opts.ref2?.toUpperCase();

  const merchantAccount =
    tlv(SUB_GUID, GUID_PROMPTPAY_BILL) +
    tlv(SUB_BILLER, biller) +
    tlv(SUB_REF1, ref1Upper) +
    (ref2Upper ? tlv(SUB_REF2, ref2Upper) : "");

  const parts = [
    tlv(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_EMV),
    tlv(ID_POI_METHOD, POI_DYNAMIC),
    tlv(ID_MERCHANT_ACCOUNT_TAG30, merchantAccount),
    tlv(ID_COUNTRY_CODE, COUNTRY_TH),
    tlv(ID_TRANSACTION_CURRENCY, CURRENCY_THB),
    tlv(ID_TRANSACTION_AMOUNT, formatAmount(opts.amountBaht)),
  ];

  const core = parts.join("");
  const withCrcTag = core + ID_CRC + "04";
  const crc = formatCrc(crc16CCITT(withCrcTag));
  return core + tlv(ID_CRC, crc);
}

/** Verify a full payload by recomputing the trailing CRC. */
export function isValidPromptPayPayload(payload: string): boolean {
  if (payload.length < 10) return false;
  const crcTagIdx = payload.length - 8;
  const crcTag = payload.slice(crcTagIdx, crcTagIdx + 4); // "6304"
  if (crcTag !== ID_CRC + "04") return false;
  const body = payload.slice(0, crcTagIdx + 4);
  const given = payload.slice(crcTagIdx + 4);
  return given === formatCrc(crc16CCITT(body));
}

/** Very shallow parser — returns amount + POI + top-level account tag used. */
export function parsePromptPayShallow(
  payload: string,
): { poi: "static" | "dynamic"; amountBaht?: number; accountTag: "29" | "30" | null } {
  const parts: Record<string, string> = {};
  let i = 0;
  while (i < payload.length - 8) {
    const tag = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) break;
    parts[tag] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  const poi = parts[ID_POI_METHOD] === POI_DYNAMIC ? "dynamic" : "static";
  const accountTag = parts[ID_MERCHANT_ACCOUNT_TAG30]
    ? ("30" as const)
    : parts[ID_MERCHANT_ACCOUNT_TAG29]
      ? ("29" as const)
      : null;
  const amt = parts[ID_TRANSACTION_AMOUNT];
  return {
    poi,
    amountBaht: amt ? Number(amt) : undefined,
    accountTag,
  };
}
