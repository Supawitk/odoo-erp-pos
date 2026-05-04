import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { guessTINKind, normalizeTIN } from '@erp/shared';
import {
  partners,
  vendorBillLines,
  vendorBills,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { buildRdUpload, type RdSenderConfig } from './pnd-rd-v2';
import { buildRdV1Upload, type RdV1Sender } from './pnd-rd-v1';

/**
 * 🇹🇭 PND.3 / PND.53 / PND.54 — monthly withholding-tax remittance to RD.
 *
 * Routing rule (knowledge.md §5):
 *   PND.3   payments to บุคคลธรรมดา (natural persons / citizens)
 *   PND.53  payments to นิติบุคคล (juristic persons / companies)
 *   PND.54  payments to ผู้รับต่างประเทศ (non-resident — §70)
 *
 * Reference month is the *payment* month (the WHT tax-point under §50).
 * Filing deadline: 7th paper / 15th e-filing of the *following* month.
 *
 * Source data: vendor_bill_lines.wht_cents > 0 where the parent bill was
 * paid within [from, to). One row per (supplier × wht_category) per period.
 */

export type PndForm = 'PND3' | 'PND53' | 'PND54';

export interface PndRow {
  /** Sequence number for the form. Re-numbered per period at render time. */
  seq: number;
  supplierId: string;
  supplierName: string;
  /** Legal name when present, else trading name. Used on the official form. */
  supplierLegalName: string;
  supplierTin: string | null;
  supplierBranchCode: string;
  whtCategory: string;
  /** Plain-Thai label of the WHT category. */
  whtCategoryLabel: string;
  /** §40 sub-section we're paying under (1, 2, 3, 4(ก), 4(ข), 5, 6, 7). */
  rdSection: string;
  rateBp: number;
  /** Sum of net amounts paid to this supplier in this category in the period. */
  paidNetCents: number;
  /** Sum of WHT withheld in this category in the period. */
  whtCents: number;
  /** Number of bills aggregated. */
  billCount: number;
  /**
   * Supplier address jsonb passed through from `partners.address`. Used by the
   * v1.0 RD-Prep emitter to populate street / district / province / postal-code.
   * Schema today is free-form `{ line1, line2, district, province, postalCode }`.
   */
  supplierAddress: Record<string, string> | null;
}

export interface PndForMonth {
  form: PndForm;
  period: string; // YYYYMM
  rows: PndRow[];
  totals: {
    paidNetCents: number;
    whtCents: number;
    billCount: number;
    supplierCount: number;
  };
}

@Injectable()
export class PndService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async forMonth(form: PndForm, year: number, month: number): Promise<PndForMonth> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const period = `${year}${String(month).padStart(2, '0')}`;

    // Pull every WHT-bearing line whose parent bill was paid in the period.
    // (We deliberately use paid_at, not bill_date — RD treats payment date as
    // the WHT tax-point.)
    const rows = await this.db
      .select({
        supplierId: vendorBills.supplierId,
        supplierName: partners.name,
        supplierLegalName: partners.legalName,
        supplierTin: partners.tin,
        supplierBranchCode: partners.branchCode,
        supplierAddress: partners.address,
        whtCategory: vendorBillLines.whtCategory,
        whtRateBp: vendorBillLines.whtRateBp,
        netCents: vendorBillLines.netCents,
        whtCents: vendorBillLines.whtCents,
        billId: vendorBills.id,
      })
      .from(vendorBillLines)
      .innerJoin(vendorBills, eq(vendorBillLines.vendorBillId, vendorBills.id))
      .leftJoin(partners, eq(partners.id, vendorBills.supplierId))
      .where(
        and(
          gte(vendorBills.paidAt, from),
          lt(vendorBills.paidAt, to),
          sql`${vendorBills.status} = 'paid'`,
          sql`${vendorBillLines.whtCents} > 0`,
        ),
      );

    // Aggregate by (supplier, wht_category) and route to the correct form.
    const buckets = new Map<
      string,
      {
        row: Omit<PndRow, 'seq'>;
        billIds: Set<string>;
      }
    >();
    for (const r of rows) {
      const formForRow = pickForm(r.supplierTin);
      if (formForRow !== form) continue;
      if (!r.whtCategory) continue;
      const key = `${r.supplierId}|${r.whtCategory}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.row.paidNetCents += Number(r.netCents);
        existing.row.whtCents += Number(r.whtCents);
        existing.billIds.add(r.billId);
      } else {
        buckets.set(key, {
          row: {
            supplierId: r.supplierId,
            supplierName: r.supplierName ?? '(unknown)',
            supplierLegalName: r.supplierLegalName ?? r.supplierName ?? '(unknown)',
            supplierTin: r.supplierTin ?? null,
            supplierBranchCode: r.supplierBranchCode ?? '00000',
            supplierAddress:
              r.supplierAddress && typeof r.supplierAddress === 'object'
                ? (r.supplierAddress as Record<string, string>)
                : null,
            whtCategory: r.whtCategory,
            whtCategoryLabel: labelFor(r.whtCategory),
            rdSection: rdSectionFor(r.whtCategory),
            rateBp: r.whtRateBp ?? 0,
            paidNetCents: Number(r.netCents),
            whtCents: Number(r.whtCents),
            billCount: 0,
          },
          billIds: new Set([r.billId]),
        });
      }
    }

    const sorted = [...buckets.values()]
      .map(({ row, billIds }) => ({ ...row, billCount: billIds.size }))
      .sort((a, b) => {
        // Stable, deterministic order: supplier name, then category.
        if (a.supplierName !== b.supplierName) {
          return a.supplierName.localeCompare(b.supplierName, 'th');
        }
        return a.whtCategory.localeCompare(b.whtCategory);
      });

    const out: PndRow[] = sorted.map((r, i) => ({ seq: i + 1, ...r }));
    const totals = out.reduce(
      (acc, r) => ({
        paidNetCents: acc.paidNetCents + r.paidNetCents,
        whtCents: acc.whtCents + r.whtCents,
        billCount: acc.billCount + r.billCount,
        supplierIds: acc.supplierIds.add(r.supplierId),
      }),
      {
        paidNetCents: 0,
        whtCents: 0,
        billCount: 0,
        supplierIds: new Set<string>(),
      },
    );

    return {
      form,
      period,
      rows: out,
      totals: {
        paidNetCents: totals.paidNetCents,
        whtCents: totals.whtCents,
        billCount: totals.billCount,
        supplierCount: totals.supplierIds.size,
      },
    };
  }

  /**
   * RD e-filing template CSV.
   * Format follows the Revenue Department's PND e-filing CSV import spec —
   * fixed column order, no quoting, UTF-8 with BOM. The template column count
   * differs by form (PND.54 has fewer cols since no Thai TIN), so each form
   * gets its own header.
   */
  toCsv(report: PndForMonth): string {
    const headers = csvHeaderFor(report.form);
    const lines = report.rows.map((r) => csvRowFor(report.form, r));
    // BOM for Excel Thai support
    return '﻿' + headers.join(',') + '\n' + lines.join('\n');
  }

  /**
   * 🇹🇭 Official RD upload format (FORMAT กลาง v2.0, 16/06/2568).
   * Pipe-delimited UTF-8 text accepted by efiling.rd.go.th's batch upload.
   *
   * PND.3 / PND.53 are fully spec-compliant. PND.54 uses the same shape as a
   * best-effort fallback — RD has not published a v2.0 spec for foreign-payment
   * batch upload; the canonical filing path for §70 is the web form or an ASP.
   */
  toRdUpload(
    report: PndForMonth,
    sender: RdSenderConfig,
  ): { filename: string; content: string } {
    return buildRdUpload(report, sender);
  }

  /**
   * 🇹🇭 v1.0 — RD-Prep ingestible format. **The format real-world SMEs use today.**
   *
   * Pipeline: emit this `.txt` → import in RD Prep (Windows desktop tool from
   * rd.go.th) → RD Prep produces `.rdx` → upload `.rdx` to efiling.rd.go.th.
   *
   * Field layout matches OCA `l10n_th_account_tax_report` defaults — 17 fields
   * for PND.3 (firstname/lastname split), 16 fields for PND.53 / PND.54.
   */
  toRdUploadV1(
    report: PndForMonth,
    sender: RdV1Sender,
  ): { filename: string; content: string } {
    return buildRdV1Upload(report, sender);
  }
}

// ─── Routing helpers ────────────────────────────────────────────────────────

function pickForm(tin: string | null | undefined): PndForm {
  if (!tin) return 'PND54'; // no Thai TIN → assume foreign
  const norm = normalizeTIN(tin);
  if (!/^\d{13}$/.test(norm)) return 'PND54';
  return guessTINKind(norm) === 'juristic' ? 'PND53' : 'PND3';
}

function labelFor(cat: string): string {
  switch (cat) {
    case 'services':
      return 'ค่าบริการ / ค่าจ้างทำของ';
    case 'rent':
      return 'ค่าเช่า';
    case 'ads':
      return 'ค่าโฆษณา';
    case 'freight':
      return 'ค่าขนส่ง';
    case 'dividends':
      return 'เงินปันผล';
    case 'interest':
      return 'ดอกเบี้ย';
    case 'foreign':
      return 'จ่ายให้ผู้รับต่างประเทศ';
    default:
      return cat;
  }
}

/**
 * RD §40 sub-section the WHT category falls under. Used to populate the
 * "ประเภทเงินที่จ่าย" column on PND forms.
 */
function rdSectionFor(cat: string): string {
  switch (cat) {
    case 'services':
    case 'ads':
      return '40(2)';
    case 'rent':
      return '40(5)';
    case 'freight':
      return '40(6)';
    case 'dividends':
      return '40(4)(ข)';
    case 'interest':
      return '40(4)(ก)';
    case 'foreign':
      return '70';
    default:
      return '40(8)';
  }
}

function csvHeaderFor(form: PndForm): string[] {
  if (form === 'PND54') {
    // PND.54 doesn't have Thai TIN; identifies foreign supplier by passport/registration
    return [
      'seq',
      'supplier_name',
      'supplier_legal_name',
      'foreign_id',
      'wht_category',
      'rd_section',
      'paid_net_baht',
      'rate_pct',
      'wht_baht',
      'bill_count',
    ];
  }
  return [
    'seq',
    'supplier_tin',
    'branch_code',
    'supplier_name',
    'supplier_legal_name',
    'wht_category',
    'rd_section',
    'paid_net_baht',
    'rate_pct',
    'wht_baht',
    'bill_count',
  ];
}

function csvRowFor(form: PndForm, r: PndRow): string {
  const baht = (cents: number) => (cents / 100).toFixed(2);
  const ratePct = (r.rateBp / 100).toFixed(2);
  if (form === 'PND54') {
    return [
      r.seq,
      csvSafe(r.supplierName),
      csvSafe(r.supplierLegalName),
      csvSafe(r.supplierTin ?? ''),
      r.whtCategory,
      r.rdSection,
      baht(r.paidNetCents),
      ratePct,
      baht(r.whtCents),
      r.billCount,
    ].join(',');
  }
  return [
    r.seq,
    csvSafe(r.supplierTin ?? ''),
    csvSafe(r.supplierBranchCode),
    csvSafe(r.supplierName),
    csvSafe(r.supplierLegalName),
    r.whtCategory,
    r.rdSection,
    baht(r.paidNetCents),
    ratePct,
    baht(r.whtCents),
    r.billCount,
  ].join(',');
}

function csvSafe(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
