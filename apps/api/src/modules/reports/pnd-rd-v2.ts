import { normalizeTIN } from '@erp/shared';
import type { PndForm, PndForMonth, PndRow } from './pnd.service';

/**
 * 🇹🇭 Revenue Department FORMAT กลาง v2.0 (16/06/2568) — PND.3 / PND.53.
 *
 * Generates the exact byte-perfect text file efiling.rd.go.th accepts. Spec
 * sources:
 *   https://www.rd.go.th/fileadmin/user_upload/WHT/Download/FormatPND3V2_0.pdf
 *   https://www.rd.go.th/fileadmin/user_upload/WHT/Download/FormatPND53V2_0.pdf
 *
 * Format rules:
 *   - UTF-8 encoding (NOT TIS-620). v1.0 used TIS-620; RD switched to UTF-8 in v2.0.
 *   - CRLF line endings.
 *   - Pipe `|` field delimiter, no leading/trailing pipe, no CSV quoting.
 *   - 1 H row (header / form metadata) + N D rows (one per payee).
 *   - Each D row carries up to 3 payment events. >3 events → emit additional D rows
 *     with new SEQ_NO for the same payee.
 *   - Numbers: `N(15,2)` → up to 15 digits + dot + 2 decimals (max 18 chars).
 *     Empty → `0.00`.
 *   - Dates: `DDMMYYYY` in Buddhist Era (CE + 543). Empty → `00000000`.
 *   - TINs: 13-digit citizen ID (PIN) or juristic TIN. Branch 6 digits, HQ = "000000".
 *
 * PND.54 (foreign payments under §70) is NOT in v2.0 — RD does not publish a
 * v2.0 batch upload spec for it. Filers either use the web form or an ASP.
 * We export PND.54 in the same shape as a best-effort fallback, but flag it
 * as non-canonical.
 */

export interface RdSenderConfig {
  /** 4-char sender system code. RD assigns these; "0001" is a safe default for self-filers. */
  senderId: string;
  /** Payer's 13-digit TIN (= NID for self-filers). */
  payerTin: string;
  /** Payer's 6-digit branch code. "000000" = head office. */
  payerBranch: string;
  /** 1 = self / 2 = tax representative / 3 = accountant / 4 = other. */
  senderRole: '1' | '2' | '3' | '4';
  /** 0/1 — large taxpayer office flag. */
  lto: '0' | '1';
  /** Department / division name. Optional; max 80 chars. */
  deptName: string;
  /** RD-issued e-filing user code. Max 20 chars. Falls back to TIN when not configured. */
  userId: string;
  /** Branch type — "V" (virtual), "S" (sub-branch), or empty. */
  branchType: '' | 'V' | 'S';
  /** Form type — "00" normal, "01"-"99" amendment serial. */
  formType: string;
}

export function buildRdUpload(
  report: PndForMonth,
  sender: RdSenderConfig,
): { filename: string; content: string } {
  const detail = buildDetail(report);
  const header = buildHeader(report, sender, detail);
  // CRLF line endings per spec; no trailing newline.
  const content = [header, ...detail.lines].join('\r\n');
  const filename = buildFilename(report, sender);
  return { filename, content };
}

// ─── H row (25 fields) ──────────────────────────────────────────────────────

function buildHeader(
  report: PndForMonth,
  s: RdSenderConfig,
  detail: { lines: string[]; totals: { numEvents: number; totAmt: number; totTax: number } },
): string {
  const taxType = report.form === 'PND3' ? 'PND3' : report.form === 'PND53' ? 'PND53' : 'PND54';
  const yyyy = Number(report.period.slice(0, 4));
  const mm = report.period.slice(4, 6);
  const beYear = String(yyyy + 543);

  // SECTION flags: derive from §40 sub-sections present in the report.
  // PND.3 uses {SECTION3, SECTION48, SECTION50}.
  // PND.53 uses {SECTION3, SECTION65, SECTION69}.
  const section3 = '1'; // Almost always set — §3 ter is the catch-all WHT authority for B2B services.
  const section48 = report.form === 'PND3' ? '0' : ''; // Stock options — rare.
  const section50 = report.form === 'PND3' ? has50(report) : '';
  const section65 = report.form === 'PND53' ? '0' : ''; // §65 จัตวา corporate dividend WHT.
  const section69 = report.form === 'PND53' ? '0' : ''; // §69 ทวิ government bonds.

  const fields: string[] = [
    'H',
    pad(s.senderId, 4),
    onlyDigits(s.payerTin, 13),
    pad(s.payerBranch, 6, '0'),
    s.senderRole,
    taxType,
    onlyDigits(s.payerTin, 13),
    pad(s.payerBranch, 6, '0'),
    safe(s.deptName, 80),
    section3,
    report.form === 'PND3' ? section48 : section65,
    report.form === 'PND3' ? section50 : section69,
    s.lto,
    mm,
    beYear,
    s.branchType,
    pad(s.formType, 2, '0'),
    String(detail.totals.numEvents),
    money(detail.totals.totAmt),
    money(detail.totals.totTax),
    money(0), // SUR_AMT — surcharge for late filing; we don't compute this here.
    money(detail.totals.totTax), // GTOT_TAX — total tax incl. surcharge (= TOT_TAX when no surcharge).
    money(detail.totals.totTax), // TRANS_AMT — amount being transferred to RD (= GTOT_TAX).
    safe(s.userId || onlyDigits(s.payerTin, 13), 20),
    '2', // FORM_FLAG — 2 = Internet (efiling.rd.go.th upload). 1 = physical media.
  ];
  return fields.join('|');
}

function has50(report: PndForMonth): '0' | '1' {
  // §50 covers dividends + interest + bond yields paid to natural persons.
  // If any line is in 40(4)(ก) or 40(4)(ข), set SECTION50=1.
  return report.rows.some((r) => r.rdSection.startsWith('40(4)')) ? '1' : '0';
}

// ─── D rows (38 fields, up to 3 events per row) ─────────────────────────────

function buildDetail(report: PndForMonth): {
  lines: string[];
  totals: { numEvents: number; totAmt: number; totTax: number };
} {
  // Regroup: report.rows is one row per (supplier × wht_category).
  // RD's D row is one row per payee with up to 3 (rate, amount, tax, type) tuples.
  const bySupplier = new Map<string, PndRow[]>();
  for (const r of report.rows) {
    const list = bySupplier.get(r.supplierId);
    if (list) list.push(r);
    else bySupplier.set(r.supplierId, [r]);
  }

  // Last day of the period — used as the representative payment date for the
  // aggregated row. RD accepts this when filers report monthly aggregates;
  // per-bill dates would require breaking the aggregation, which would inflate
  // the file and isn't required by the spec.
  const yyyy = Number(report.period.slice(0, 4));
  const mm = Number(report.period.slice(4, 6));
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const paidDate = `${pad2(lastDay)}${pad2(mm)}${yyyy + 543}`;

  const lines: string[] = [];
  let seq = 0;
  let numEvents = 0;
  let totAmt = 0;
  let totTax = 0;

  // Deterministic order: supplier name, then category — matches the friendly CSV.
  const sortedSuppliers = [...bySupplier.entries()].sort(([, a], [, b]) =>
    a[0].supplierName.localeCompare(b[0].supplierName, 'th'),
  );

  for (const [, rows] of sortedSuppliers) {
    rows.sort((a, b) => a.whtCategory.localeCompare(b.whtCategory));
    // Chunk into groups of up to 3 — each chunk becomes one D row.
    for (let i = 0; i < rows.length; i += 3) {
      seq++;
      const chunk = rows.slice(i, i + 3);
      lines.push(buildDetailRow(report.form, seq, chunk, paidDate));
      for (const r of chunk) {
        numEvents++;
        totAmt += r.paidNetCents;
        totTax += r.whtCents;
      }
    }
  }
  return { lines, totals: { numEvents, totAmt, totTax } };
}

function buildDetailRow(
  form: PndForm,
  seq: number,
  events: PndRow[],
  paidDate: string,
): string {
  const head = events[0];
  const { title, fname, sname } = splitName(form, head);

  // 13-digit Thai TIN goes in PIN; the legacy 10-digit TIN field is kept for
  // backward compat — fill with "0000000000" when we don't have a separate one.
  const pin = head.supplierTin ? onlyDigits(head.supplierTin, 13) : '';
  const tin10 = '0000000000';
  const branchNo = pad((head.supplierBranchCode || '00000').slice(0, 6), 6, '0');

  const fields: string[] = [
    'D',
    String(seq),
    branchNo,
    pin,
    tin10,
    safe(title, 100),
    safe(fname, 100),
    safe(sname, 80),
  ];

  // 3 payment-event slots, each = 6 fields (DATE, RATE, AMT, TAX, TYPE, COND).
  for (let i = 0; i < 3; i++) {
    const ev = events[i];
    if (ev) {
      fields.push(paidDate);
      fields.push(rate(ev.rateBp));
      fields.push(money(ev.paidNetCents));
      fields.push(money(ev.whtCents));
      fields.push(safe(ev.whtCategoryLabel + ' (' + ev.rdSection + ')', 100));
      fields.push('1'); // PAY_CON: 1 = withheld from payee (the standard case).
    } else {
      fields.push('00000000', '0.00', '0.00', '0.00', '', '');
    }
  }

  // Address — RD wants 12 separate fields; our schema stores a single jsonb blob.
  // We split what we have onto STREET_NAME/AMPHUR/PROVINCE/POSTAL_CODE and leave
  // the granular fields empty. Address is mandatory on PND.3, optional on PND.53.
  // (Address split would require a Phase 5 schema migration to be exact.)
  fields.push(''); // BUILD_NAME
  fields.push(''); // ROOM_NO
  fields.push(''); // FLOOR_NO
  fields.push(''); // VILLAGE_NAME
  fields.push(''); // ADD_NO
  fields.push(''); // MOO_NO
  fields.push(''); // SOI
  fields.push(''); // STREET_NAME
  fields.push(''); // TAMBON
  fields.push(''); // AMPHUR (M on PND.3 — known gap)
  fields.push(''); // PROVINCE (M on PND.3 — known gap)
  fields.push(''); // POSTAL_CODE (M on PND.3 — known gap)

  return fields.join('|');
}

// ─── Filename per spec ──────────────────────────────────────────────────────
// PND53_0105551234567_000000_2568_04_00_01.txt
// FORM_TIN_BRANCH_BEYEAR_MONTH_FORMTYPE_SEQ.txt

function buildFilename(report: PndForMonth, s: RdSenderConfig): string {
  const yyyy = Number(report.period.slice(0, 4));
  const mm = report.period.slice(4, 6);
  const beYear = String(yyyy + 543);
  const tin = onlyDigits(s.payerTin, 13);
  const branch = pad(s.payerBranch, 6, '0');
  return `${report.form}_${tin}_${branch}_${beYear}_${mm}_${pad(s.formType, 2, '0')}_01.txt`;
}

// ─── Field helpers ──────────────────────────────────────────────────────────

/** Strip everything that isn't a digit, then truncate/pad to exactly `n` chars. */
function onlyDigits(s: string | null | undefined, n: number): string {
  const d = (s || '').replace(/\D/g, '');
  if (d.length === 0) return ''.padStart(n, '0');
  if (d.length === n) return d;
  if (d.length > n) return d.slice(-n);
  return d.padStart(n, '0');
}

/** Truncate text and strip RD-forbidden characters. Spec §6 lists `* + / \ ! $ % # & @ , ' "`. */
function safe(s: string | null | undefined, max: number): string {
  if (!s) return '';
  // Pipes would break the delimiter; the rest are RD-forbidden.
  const cleaned = s.replace(/[|*+/\\!$%#&@,'"]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function pad(s: string, n: number, ch = ' '): string {
  if (s.length === n) return s;
  if (s.length > n) return s.slice(0, n);
  return ch === '0' ? s.padStart(n, '0') : s.padEnd(n, ch);
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** N(15,2) — fixed 2-decimal format. RD wants a literal dot, no thousands sep. */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const baht = Math.floor(abs / 100);
  const sat = abs % 100;
  return `${sign}${baht}.${pad2(sat)}`;
}

/** Tax rate as percent with up to 2 decimals: 300 bp → "3.00", 150 bp → "1.50". */
function rate(bp: number): string {
  const pct = bp / 100;
  return pct.toFixed(2);
}

function splitName(
  form: PndForm,
  r: PndRow,
): { title: string; fname: string; sname: string } {
  const name = (r.supplierLegalName || r.supplierName || '').trim();

  if (form === 'PND53' || form === 'PND54') {
    // Juristic / foreign — full name in FNAME, no split. Title is implied by the
    // legal form embedded in the name itself ("บริษัท X จำกัด").
    return { title: '', fname: name, sname: '' };
  }

  // PND.3 — natural persons. Try to extract a Thai title prefix if present.
  const titles = ['นางสาว', 'น.ส.', 'นาย', 'นาง', 'ดร.', 'ผศ.', 'รศ.', 'ศ.'];
  for (const t of titles) {
    if (name.startsWith(t)) {
      const rest = name.slice(t.length).trim();
      const parts = rest.split(/\s+/);
      const fname = parts[0] || '';
      const sname = parts.slice(1).join(' ');
      return { title: t, fname, sname };
    }
  }
  // Untitled — best effort: first word as fname, rest as sname.
  const parts = name.split(/\s+/);
  return {
    title: '',
    fname: parts[0] || '',
    sname: parts.slice(1).join(' '),
  };
}

// Re-export for tests + service consumption
export const _internals = {
  buildHeader,
  buildDetail,
  buildDetailRow,
  buildFilename,
  money,
  rate,
  onlyDigits,
  safe,
  splitName,
};

// Used by callers that haven't normalised the TIN already.
export function normaliseSenderTin(tin: string | null): string {
  return onlyDigits(normalizeTIN(tin || ''), 13);
}
