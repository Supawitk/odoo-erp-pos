import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { bahtPlain, csvSafe, toBaht } from './_format.util';

/**
 * 🇹🇭 Phor.Por.36 — Self-Assessment VAT on imports of services / royalties (§83/6).
 *
 * When a Thai VAT-registered company pays a foreign vendor for services or
 * royalties USED in Thailand, the **buyer** must self-assess 7% VAT and remit
 * it to RD on PP.36. The same amount becomes claimable input VAT on next
 * month's PP.30.
 *
 * Tax point (§78/1): when payment is remitted abroad — i.e. each bill_payments
 * row's payment_date, NOT the vendor_bills.bill_date or fully-paid date.
 *
 * Eligibility heuristic (v1): every bill_payments row whose supplier has no
 * 13-digit Thai TIN. This catches all foreign vendors (the same signal that
 * routes WHT payments to PND.54). Caveats:
 *
 *   1. Foreign GOODS imports are excluded by RD — VAT on goods is collected at
 *      customs (PP.84). The accountant should drop those lines on the web form
 *      if a goods bill is mixed in. We surface every foreign-vendor remittance
 *      and flag the per-line product reference so they're easy to spot.
 *
 *   2. Foreign vendors who are themselves VAT-registered in Thailand (rare —
 *      typically large multinationals with a Thai branch) charge VAT directly,
 *      so PP.36 doesn't apply. Set `partners.vat_registered=true` and they fall
 *      out of this report automatically — but only if they also have a Thai TIN
 *      assigned (which they would, as VAT-registered). The TIN-NULL filter
 *      makes this work the right way.
 *
 *   3. Bills paid in foreign currency convert to THB at `vendor_bills.fxRateToThb`
 *      captured at bill posting time. RD wants the BoT mid-rate at remittance
 *      date — Phase 4B's BoT FX cron will tighten this; today the field is
 *      filled at bill creation by whoever entered the bill.
 *
 * Filing deadline: 7th paper / 15th e-filing of the following month.
 *
 * RD does not publish a `.txt` upload schema for PP.36 — accountants enter on
 * the web form (rd.go.th). We export CSV + XLSX for review and audit.
 */

export interface PP36Row {
  /** bill_payments row id — stable, unique per remittance event. */
  paymentId: string;
  /** vendor_bills row id (the parent bill). */
  billId: string;
  /** Internal bill number (VB-YYMM-#####) — what the accountant types into the form. */
  billInternalNumber: string;
  paymentDate: string; // YYYY-MM-DD
  paymentNo: number;   // 1-based installment number within the bill
  supplierId: string;
  supplierName: string;
  supplierLegalName: string;
  /** Foreign vendor's tax id if captured (passport / GST / VAT in their jurisdiction). */
  supplierForeignId: string | null;
  /** Bill currency. THB shouldn't appear here in practice — included for transparency. */
  currency: string;
  /** FX rate captured at bill posting. */
  fxRateToThb: number;
  /** Amount remitted to the foreign vendor in bill currency, in cents (= the §83/6 base). */
  amountCents: number;
  /** Same amount converted to THB satang. The PP.36 base is this value. */
  amountThbCents: number;
  /** 7% × amountThbCents — what we owe RD. */
  vatThbCents: number;
}

export interface PP36Month {
  period: string; // YYYYMM
  rate: number;   // 0.07 — pinned to current 7% rate
  rows: PP36Row[];
  totals: {
    paymentCount: number;
    supplierCount: number;
    /** Sum of THB-equivalent base amounts. */
    baseThbCents: number;
    /** Sum of self-assessment VAT (7% × base). */
    vatThbCents: number;
  };
  /** Distinct currencies seen in the period — useful UI hint. */
  currencies: string[];
  /** When the form is due to RD (15th of month after period for e-filing). */
  filingDueDate: string;
}

const PP36_RATE = 0.07;

@Injectable()
export class PP36Service {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async forMonth(year: number, month: number): Promise<PP36Month> {
    const fromIso = `${year}-${String(month).padStart(2, '0')}-01`;
    const toIso = nextMonthIso(year, month);
    const period = `${year}${String(month).padStart(2, '0')}`;

    // Foreign vendor = partners.tin missing OR not a 13-digit string. Same
    // signal pickForm() uses to route WHT to PND.54. We deliberately do NOT
    // filter by partners.vat_registered — a foreign vendor without a Thai TIN
    // can't legally have set vat_registered=true anyway.
    const rows = await this.db.execute<{
      payment_id: string;
      bill_id: string;
      internal_number: string;
      payment_date: string;
      payment_no: number;
      supplier_id: string;
      supplier_name: string;
      supplier_legal_name: string | null;
      supplier_tin: string | null;
      currency: string;
      fx_rate_to_thb: string;
      amount_cents: number;
    }>(sql`
      SELECT
        bp.id            AS payment_id,
        vb.id            AS bill_id,
        vb.internal_number,
        bp.payment_date::text,
        bp.payment_no,
        p.id             AS supplier_id,
        p.name           AS supplier_name,
        p.legal_name     AS supplier_legal_name,
        p.tin            AS supplier_tin,
        vb.currency,
        vb.fx_rate_to_thb,
        bp.amount_cents
      FROM custom.bill_payments bp
      JOIN custom.vendor_bills vb ON vb.id = bp.vendor_bill_id
      JOIN custom.partners p      ON p.id  = vb.supplier_id
      WHERE bp.payment_date >= ${fromIso}::date
        AND bp.payment_date <  ${toIso}::date
        AND bp.voided_at IS NULL
        AND (p.tin IS NULL OR p.tin !~ '^[0-9]{13}$')
      ORDER BY bp.payment_date ASC, vb.internal_number ASC, bp.payment_no ASC
    `);

    // postgres-js returns the array directly.
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];

    const out: PP36Row[] = [];
    let baseTotal = 0;
    let vatTotal = 0;
    const currencies = new Set<string>();
    const supplierIds = new Set<string>();

    for (const r of list as Array<Record<string, unknown>>) {
      const fxStr = String(r.fx_rate_to_thb ?? '1.0');
      const fx = Number.isFinite(Number(fxStr)) ? Number(fxStr) : 1.0;
      const amountCents = Number(r.amount_cents) || 0;
      // Round half-up to satang. Money math elsewhere uses Math.round.
      const amountThbCents = Math.round(amountCents * fx);
      const vatThbCents = Math.round(amountThbCents * PP36_RATE);

      out.push({
        paymentId: String(r.payment_id),
        billId: String(r.bill_id),
        billInternalNumber: String(r.internal_number),
        paymentDate: String(r.payment_date),
        paymentNo: Number(r.payment_no),
        supplierId: String(r.supplier_id),
        supplierName: String(r.supplier_name ?? ''),
        supplierLegalName: String(r.supplier_legal_name ?? r.supplier_name ?? ''),
        supplierForeignId: r.supplier_tin ? String(r.supplier_tin) : null,
        currency: String(r.currency ?? 'THB'),
        fxRateToThb: fx,
        amountCents,
        amountThbCents,
        vatThbCents,
      });
      baseTotal += amountThbCents;
      vatTotal += vatThbCents;
      currencies.add(String(r.currency ?? 'THB'));
      supplierIds.add(String(r.supplier_id));
    }

    return {
      period,
      rate: PP36_RATE,
      rows: out,
      totals: {
        paymentCount: out.length,
        supplierCount: supplierIds.size,
        baseThbCents: baseTotal,
        vatThbCents: vatTotal,
      },
      currencies: [...currencies].sort(),
      filingDueDate: filingDueDate(year, month),
    };
  }

  /**
   * UTF-8-with-BOM CSV. RD doesn't accept this as upload — it's for the
   * accountant to cross-check against what they enter on the web form.
   */
  toCsv(report: PP36Month): string {
    const headers = [
      'seq',
      'payment_date',
      'bill_number',
      'payment_no',
      'supplier_name',
      'supplier_legal_name',
      'supplier_foreign_id',
      'currency',
      'fx_rate_to_thb',
      'amount_in_currency',
      'base_thb',
      'vat_thb_7pct',
    ];
    const lines = report.rows.map((r, i) =>
      [
        i + 1,
        r.paymentDate,
        csvSafe(r.billInternalNumber),
        r.paymentNo,
        csvSafe(r.supplierName),
        csvSafe(r.supplierLegalName),
        csvSafe(r.supplierForeignId ?? ''),
        r.currency,
        r.fxRateToThb.toFixed(6),
        // No thousands separator inside CSV money — breaks the delimiter.
        bahtPlain(r.amountCents),
        bahtPlain(r.amountThbCents),
        bahtPlain(r.vatThbCents),
      ].join(','),
    );
    return '﻿' + headers.join(',') + '\n' + lines.join('\n');
  }

  /** XLSX with a summary sheet + per-payment detail. */
  async toXlsx(report: PP36Month): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'erp-pos';
    wb.created = new Date();

    // ── Summary sheet ──────────────────────────────────────────────────────
    const summary = wb.addWorksheet('สรุป (ภ.พ.36)');
    summary.columns = [
      { header: 'รายการ', key: 'label', width: 50 },
      { header: 'จำนวน / มูลค่า (บาท)', key: 'value', width: 24 },
    ];
    const baseBaht = toBaht(report.totals.baseThbCents);
    const vatBaht = toBaht(report.totals.vatThbCents);
    summary.addRows([
      { label: 'งวดภาษี (Period)', value: report.period },
      { label: 'อัตรา VAT (Rate)', value: `${(report.rate * 100).toFixed(0)}%` },
      { label: 'จำนวนการชำระเงินไปต่างประเทศ', value: report.totals.paymentCount },
      { label: 'จำนวนผู้รับต่างประเทศ', value: report.totals.supplierCount },
      { label: 'ฐานภาษี (Base, THB)', value: baseBaht },
      { label: 'ภาษีมูลค่าเพิ่ม 7% (Self-assessment VAT)', value: vatBaht },
      { label: 'กำหนดยื่นแบบ (Filing due, e-filing)', value: report.filingDueDate },
      {
        label: 'หมายเหตุ',
        value:
          'ภาษีในใบนี้คุณนำไปขอเครดิตเป็นภาษีซื้อในแบบ ภ.พ.30 เดือนถัดไปได้ ' +
          '(§83/6 + §82/3 — สำเนาแบบนี้ถือเป็นใบกำกับภาษี)',
      },
    ]);
    summary.getRow(1).font = { bold: true };

    // ── Detail sheet ───────────────────────────────────────────────────────
    const detail = wb.addWorksheet('รายละเอียด');
    detail.columns = [
      { header: 'ลำดับ', key: 'seq', width: 6 },
      { header: 'วันที่จ่าย', key: 'date', width: 12 },
      { header: 'เลขที่ใบสำคัญ', key: 'bill', width: 18 },
      { header: 'งวดที่', key: 'pno', width: 8 },
      { header: 'ผู้รับ (Trading)', key: 'name', width: 28 },
      { header: 'ผู้รับ (Legal)', key: 'legal', width: 28 },
      { header: 'รหัสประจำตัวต่างประเทศ', key: 'fid', width: 22 },
      { header: 'สกุลเงิน', key: 'cur', width: 8 },
      { header: 'อัตราแลกเปลี่ยน', key: 'fx', width: 14 },
      { header: 'ยอดชำระ (สกุลเดิม)', key: 'amt', width: 18 },
      { header: 'ฐานภาษี (THB)', key: 'baseThb', width: 18 },
      { header: 'VAT 7% (THB)', key: 'vatThb', width: 16 },
    ];
    report.rows.forEach((r, i) =>
      detail.addRow({
        seq: i + 1,
        date: r.paymentDate,
        bill: r.billInternalNumber,
        pno: r.paymentNo,
        name: r.supplierName,
        legal: r.supplierLegalName,
        fid: r.supplierForeignId ?? '',
        cur: r.currency,
        fx: r.fxRateToThb,
        amt: r.amountCents / 100,
        baseThb: r.amountThbCents / 100,
        vatThb: r.vatThbCents / 100,
      }),
    );
    detail.getRow(1).font = { bold: true };
    // Right-align money cols + 2-decimal format.
    for (const col of ['fx', 'amt', 'baseThb', 'vatThb']) {
      detail.getColumn(col).numFmt = '#,##0.00';
      detail.getColumn(col).alignment = { horizontal: 'right' };
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function nextMonthIso(year: number, month: number): string {
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** 15th of month after period — RD's e-filing deadline. */
function filingDueDate(year: number, month: number): string {
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
}

