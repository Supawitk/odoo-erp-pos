import type { PndForm, PndForMonth, PndRow } from './pnd.service';

/**
 * 🇹🇭 Revenue Department v1.0 (RD-Prep input) format — PND.3 / PND.53.
 *
 * This is the format that real-world Thai SMEs and accountants use today:
 *   1. Generate this file (pipe-delimited UTF-8 text, no header row).
 *   2. Open RD Prep (RD's free desktop tool, Windows).
 *   3. Import the .txt file.
 *   4. RD Prep validates, computes summaries, and writes a `.rdx` package.
 *   5. Upload the `.rdx` to efiling.rd.go.th.
 *
 * Why we generate this and not v2.0: v2.0 (FORMAT กลาง, dated 16/06/2568)
 * is RD's newer Software Component (SWC) / direct-API path — designed for
 * software vendors enrolled with RD as integration partners. SMEs filing on
 * their own use RD Prep, which ingests v1.0. Source: rd.go.th/63724.html
 * page text and Leceipt/FlowAccount/PEAK/EASY-ACC/HumanSoft/SAP docs.
 *
 * Field layout matches OCA `l10n_th_account_tax_report` defaults exactly so
 * the file is interchangeable with what users already file via Odoo:
 *   - PND.3:  17 fields per detail row (firstname/lastname split)
 *   - PND.53: 16 fields per detail row (single partner_name field)
 *
 * Encoding: UTF-8 (no BOM), CRLF line endings, pipe `|` delimiter,
 * no leading/trailing pipe per row. Money: `1,234.50` (with thousands separator
 * inside values is fine because the field delimiter is `|`). Date: DDMMYYYY in
 * Buddhist Era. PAY_CON: 1 = withhold from payee (default); 2/3 swap between
 * forms when payer absorbs the tax — see PAY_CON helper below.
 *
 * One detail row per (supplier × wht_category) pair, matching OCA's "loop"
 * semantics. The aggregator in `pnd.service.ts` already does this grouping.
 */

export interface RdV1Sender {
  /** Payer's TIN — appears on RD Prep's import dialog title only; not in the file body. */
  payerTin: string;
  /** Payer's branch code; used only by the filename, not the body. */
  payerBranch: string;
  /** Form type, "00"=normal, "01"-"99"=amendment serial. Filename only. */
  formType: string;
}

export type WhtPayerMode = 'withhold' | 'paid_one_time' | 'paid_continuously';

export function buildRdV1Upload(
  report: PndForMonth,
  sender: RdV1Sender,
): { filename: string; content: string } {
  const lines = report.rows.map((r, i) => buildRow(report.form, i + 1, r, report.period));
  // CRLF per RD Prep convention (Windows app).
  const content = lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
  return { filename: buildFilename(report, sender), content };
}

// ─── Detail row ─────────────────────────────────────────────────────────────

function buildRow(form: PndForm, seq: number, r: PndRow, period: string): string {
  const branch = pad((r.supplierBranchCode || '00000').padStart(6, '0').slice(0, 6), 6, '0');
  const tin = onlyDigits(r.supplierTin || '', 13);
  const { title, fname, sname } = splitName(form, r);
  const addr = parseAddress(r);

  // Last day of period as the representative payment date for the aggregate.
  // RD Prep interprets DDMMYYYY in BE — same convention as OCA's _convert_wht_tax_payer.
  const yyyy = Number(period.slice(0, 4));
  const mm = Number(period.slice(4, 6));
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const certDate = `${pad2(lastDay)}${pad2(mm)}${yyyy + 543}`;

  const incomeDesc = r.whtCategoryLabel || r.whtCategory || '';
  const ratePct = r.rateBp / 100;
  // Money in `1,234.50` form — thousands sep inside the value, decimals always 2.
  const base = money(r.paidNetCents);
  const amount = money(r.whtCents);
  // PAY_CON: hardcoded `1` (withheld from payee) — the standard case for ~95%
  // of SME flows. When `payer_absorbs_wht` is added to vendor_bill_lines (as a
  // schema migration), swap to `payConFor(form, mode)` to emit 2/3 correctly.
  const payCon = '1';

  const fields: string[] =
    form === 'PND3'
      ? [
          // 17 fields — matches OCA wht_text_file_pnd3_format default.
          String(seq),
          tin,
          branch,
          safe(title, 100),
          safe(fname, 100),
          safe(sname, 80),
          safe(addr.street, 100),
          safe(addr.street2, 100),
          safe(addr.city, 50),
          safe(addr.state, 50),
          safe(addr.zip, 5),
          certDate,
          safe(incomeDesc, 100),
          ratePct.toFixed(2),
          base,
          amount,
          payCon,
        ]
      : [
          // 16 fields — matches OCA wht_text_file_pnd53_format default.
          // PND.53 + PND.54 use a single combined name field instead of
          // firstname/lastname; we route both through here.
          String(seq),
          tin,
          branch,
          safe(title, 100),
          safe(r.supplierLegalName || r.supplierName, 200),
          safe(addr.street, 100),
          safe(addr.street2, 100),
          safe(addr.city, 50),
          safe(addr.state, 50),
          safe(addr.zip, 5),
          certDate,
          safe(incomeDesc, 100),
          ratePct.toFixed(2),
          base,
          amount,
          payCon,
        ];

  return fields.join('|');
}

// ─── Filename ───────────────────────────────────────────────────────────────
// Same convention as v2.0 — RD Prep doesn't parse the filename, but a
// consistent name makes file management easier:
//   PND53_<13-digit-tin>_<6-digit-branch>_<BE-year>_<MM>_<formType>_v1.txt
function buildFilename(report: PndForMonth, s: RdV1Sender): string {
  const yyyy = Number(report.period.slice(0, 4));
  const mm = report.period.slice(4, 6);
  const beYear = String(yyyy + 543);
  return `${report.form}_${onlyDigits(s.payerTin, 13)}_${pad(s.payerBranch.padStart(6, '0').slice(0, 6), 6, '0')}_${beYear}_${mm}_${pad(s.formType, 2, '0')}_v1.txt`;
}

// ─── PAY_CON swap helper ────────────────────────────────────────────────────

/**
 * Per-form mapping of payer-absorbs flag to the RD `cert_tax_payer` code.
 *
 * Codes 2 and 3 swap meaning between forms — this is the well-documented
 * Thai gotcha. Reference: OCA `wht_report.py` lines 92-98.
 *
 * Currently unused at call site (we always emit `1`) — exported so a future
 * migration that adds `vendor_bill_lines.wht_payer_mode` can flip behaviour
 * without changing the emitter shape.
 */
export function payConFor(form: PndForm, mode: WhtPayerMode): '1' | '2' | '3' {
  if (mode === 'withhold') return '1';
  if (form === 'PND53') {
    return mode === 'paid_one_time' ? '2' : '3';
  }
  // PND.3 / PND.1 / PND.54 — the swap.
  return mode === 'paid_one_time' ? '3' : '2';
}

// ─── Address parser ─────────────────────────────────────────────────────────

interface ParsedAddress {
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Best-effort split of the partner's `address` jsonb blob into the 5 RD-required
 * address fields. Schema today is a free-form `{ line1, line2, district, province,
 * postalCode, country }` — until we add a Phase-5 migration that splits these
 * into discrete columns, we parse what we have here.
 */
function parseAddress(r: PndRow): ParsedAddress {
  const a = (r as PndRow & { supplierAddress?: Record<string, string> | null }).supplierAddress;
  if (!a || typeof a !== 'object') {
    return { street: '', street2: '', city: '', state: '', zip: '' };
  }
  return {
    street: (a.line1 || a.street || '').toString(),
    street2: (a.line2 || a.street2 || '').toString(),
    city: (a.district || a.city || a.amphur || '').toString(),
    state: (a.province || a.state || '').toString(),
    zip: (a.postalCode || a.zip || a.postal_code || '').toString(),
  };
}

// ─── Field helpers ──────────────────────────────────────────────────────────

function onlyDigits(s: string, n: number): string {
  const d = (s || '').replace(/\D/g, '');
  if (d.length === 0) return '';
  if (d.length === n) return d;
  if (d.length > n) return d.slice(-n);
  return d.padStart(n, '0');
}

/** Strip RD-forbidden chars and truncate. Same set as v2.0; pipes break the delimiter. */
function safe(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const cleaned = String(s).replace(/[|*+/\\!$%#&@'"]/g, ' ').replace(/\s+/g, ' ').trim();
  // Note: comma `,` is left alone — v1.0 / RD Prep accepts commas inside values
  // (the field separator is `|`). v2.0 forbids commas.
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function pad(s: string, n: number, ch = '0'): string {
  if (s.length === n) return s;
  if (s.length > n) return s.slice(0, n);
  return ch === '0' ? s.padStart(n, '0') : s.padEnd(n, ch);
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** N(15,2) — `1,234.50` form with thousands separator (RD Prep–accepted). */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const baht = Math.floor(abs / 100);
  const sat = abs % 100;
  return `${sign}${baht.toLocaleString('en-US')}.${pad2(sat)}`;
}

function splitName(
  form: PndForm,
  r: PndRow,
): { title: string; fname: string; sname: string } {
  const name = (r.supplierLegalName || r.supplierName || '').trim();
  if (form !== 'PND3') {
    return { title: '', fname: name, sname: '' };
  }
  const titles = ['นางสาว', 'น.ส.', 'นาย', 'นาง', 'ดร.', 'ผศ.', 'รศ.', 'ศ.'];
  for (const t of titles) {
    if (name.startsWith(t)) {
      const rest = name.slice(t.length).trim();
      const parts = rest.split(/\s+/);
      return { title: t, fname: parts[0] || '', sname: parts.slice(1).join(' ') };
    }
  }
  const parts = name.split(/\s+/);
  return { title: '', fname: parts[0] || '', sname: parts.slice(1).join(' ') };
}
