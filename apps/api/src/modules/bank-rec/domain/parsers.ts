/**
 * Pure parsers for bank-statement files. Both produce the same canonical
 * shape so the import service can treat them uniformly.
 *
 * Why I'm not using `ofx-js`:
 *   1. Most Thai banks export OFX 2.x with quirks (BOM, mixed line endings,
 *      missing FITID on some lines). A focused parser is easier to debug.
 *   2. We only need a handful of fields; a 60-line regex parser ships
 *      faster than a dependency that we'd then need to wrap anyway.
 *   3. CSV is far more common in Thailand (banks prefer XLSX/CSV exports
 *      over OFX), so CSV is the primary path.
 *
 * Both parsers throw `BankParseError` on malformed input — the import
 * service catches and returns 422.
 */

export interface ParsedBankLine {
  /** ISO yyyy-mm-dd. */
  postedAt: string;
  /** Signed in BANK perspective: positive = inflow to our account. */
  amountCents: number;
  /** Free-text description from the bank. May be empty. */
  description: string;
  /** Bank's own reference / FITID. May be null when bank doesn't supply one. */
  bankRef: string | null;
}

export interface ParsedStatement {
  bankLabel: string | null;
  statementFrom: string | null;
  statementTo: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  lines: ParsedBankLine[];
}

export class BankParseError extends Error {
  constructor(
    public readonly code: 'EMPTY_FILE' | 'BAD_HEADER' | 'BAD_LINE' | 'NO_LINES',
    message: string,
  ) {
    super(message);
    this.name = 'BankParseError';
  }
}

// ─── OFX (Open Financial Exchange) ──────────────────────────────────────────
/**
 * Subset of OFX 2.x sufficient for SME Thai bank exports. Extracts:
 *   - <BANKACCTFROM><ACCTID> as bankLabel
 *   - <DTSTART> / <DTEND> as statement period
 *   - <BALAMT> in <LEDGERBAL> as closing balance
 *   - <STMTTRN> blocks for each transaction
 */
export function parseOfx(raw: string): ParsedStatement {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    throw new BankParseError('EMPTY_FILE', 'OFX file is empty');
  }
  if (!/<STMTTRN>/i.test(text) && !/<BANKTRANLIST>/i.test(text)) {
    throw new BankParseError('BAD_HEADER', 'No <STMTTRN> blocks found — not a bank statement OFX');
  }

  const bankLabel = extractTag(text, 'ACCTID') ?? extractTag(text, 'BANKID') ?? null;
  const statementFrom = ofxDate(extractTag(text, 'DTSTART'));
  const statementTo = ofxDate(extractTag(text, 'DTEND'));
  const closingBalance = ofxAmountCents(extractTag(text, 'BALAMT'));

  const lines: ParsedBankLine[] = [];
  const txnRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  while ((m = txnRe.exec(text))) {
    const block = m[1];
    const dateStr = ofxDate(extractTag(block, 'DTPOSTED'));
    const amountStr = extractTag(block, 'TRNAMT');
    if (!dateStr || amountStr == null) continue;
    const amount = ofxAmountCents(amountStr);
    if (amount == null) continue;
    lines.push({
      postedAt: dateStr,
      amountCents: amount,
      description:
        (extractTag(block, 'NAME') ?? '') +
        (extractTag(block, 'MEMO') ? ' | ' + extractTag(block, 'MEMO') : ''),
      bankRef: extractTag(block, 'FITID') ?? null,
    });
  }

  if (lines.length === 0) {
    throw new BankParseError('NO_LINES', 'No transactions parsed from OFX');
  }

  return {
    bankLabel,
    statementFrom,
    statementTo,
    openingBalanceCents: null,
    closingBalanceCents: closingBalance,
    lines,
  };
}

function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<\\n\\r]+)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function ofxDate(raw: string | null): string | null {
  if (!raw) return null;
  // OFX dates are YYYYMMDD or YYYYMMDDHHMMSS, optionally with [-7:TIMEZONE].
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function ofxAmountCents(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // OFX amounts are decimal THB. Convert to integer satang.
  return Math.round(n * 100);
}

// ─── CSV ────────────────────────────────────────────────────────────────────
/**
 * Generic CSV bank statement. Auto-detects column mapping from the header
 * row. Supports common Thai bank exports (KBank, SCB, BBL, KTB, BAY).
 *
 * Required columns (any localised label):
 *   date | วันที่
 *   amount (single signed col) OR debit + credit (separate cols)
 *   description | รายละเอียด | memo
 *
 * Optional:
 *   reference | อ้างอิง | bank_ref | fitid
 *
 * Convention: signed amount column in the bank's perspective. If only
 * debit + credit columns exist, amount = credit − debit (an inflow shows
 * up in the credit column from the bank's perspective).
 */
export function parseCsv(raw: string): ParsedStatement {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new BankParseError('EMPTY_FILE', 'CSV file is empty');

  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new BankParseError('NO_LINES', 'CSV needs a header row + at least one data row');
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...labels: string[]) =>
    header.findIndex((h) => labels.some((l) => h === l || h.includes(l)));

  const dateCol = find('date', 'posted', 'วันที่', 'วันโอน');
  const amountCol = find('amount', 'จำนวน', 'จำนวนเงิน');
  const debitCol = find('debit', 'withdraw', 'ถอน');
  const creditCol = find('credit', 'deposit', 'ฝาก');
  const descCol = find('description', 'desc', 'memo', 'รายละเอียด', 'รายการ');
  const refCol = find('reference', 'ref', 'อ้างอิง', 'fitid');

  if (dateCol < 0) {
    throw new BankParseError('BAD_HEADER', 'CSV is missing a date column');
  }
  if (amountCol < 0 && (debitCol < 0 || creditCol < 0)) {
    throw new BankParseError(
      'BAD_HEADER',
      'CSV needs either an amount column or both debit + credit columns',
    );
  }

  const lines: ParsedBankLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0 || (r.length === 1 && !r[0].trim())) continue;
    const dateStr = parseCsvDate(r[dateCol]);
    if (!dateStr) continue;

    let amount: number;
    if (amountCol >= 0) {
      amount = parseCsvAmountCents(r[amountCol]);
    } else {
      const credit = parseCsvAmountCents(r[creditCol] ?? '');
      const debit = parseCsvAmountCents(r[debitCol] ?? '');
      amount = credit - debit;
    }
    if (!Number.isFinite(amount) || amount === 0) continue;

    lines.push({
      postedAt: dateStr,
      amountCents: amount,
      description: descCol >= 0 ? (r[descCol] ?? '').trim() : '',
      bankRef: refCol >= 0 ? (r[refCol] ?? '').trim() || null : null,
    });
  }

  if (lines.length === 0) {
    throw new BankParseError('NO_LINES', 'No data rows parsed from CSV');
  }

  return {
    bankLabel: null,
    statementFrom: lines[0].postedAt,
    statementTo: lines[lines.length - 1].postedAt,
    openingBalanceCents: null,
    closingBalanceCents: null,
    lines,
  };
}

/**
 * Minimal RFC4180-ish CSV row parser. Handles quoted fields with embedded
 * commas / quotes. NOT a full RFC4180 parser — but covers every Thai bank
 * export shape I've seen.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  if (cur || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function parseCsvDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // ISO yyyy-mm-dd
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy (Thai banks)
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // yyyy/mm/dd
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function parseCsvAmountCents(raw: string): number {
  if (!raw) return 0;
  // Strip Thai/Western thousands sep, currency markers, parens-as-negative.
  let s = raw.trim().replace(/,/g, '').replace(/฿/g, '').trim();
  if (!s) return 0;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) * (negative ? -1 : 1);
}
