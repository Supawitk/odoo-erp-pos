import ExcelJS from 'exceljs';
import {
  CATEGORY_LABELS_EN,
  CATEGORY_LABELS_TH,
  NON_DEDUCTIBLE_CATEGORIES,
  type NonDeductibleCategory,
} from './non-deductible.calculator';
import type { CitPreviewResult } from './cit.service';
import { formatTinDisplay } from './_format.util';

/**
 * 🇹🇭 PND.50 / PND.51 — RD-friendly Excel filing worksheet.
 *
 * Real-world Thai SMEs and accountants don't re-create the official RD .pdf
 * (it's a typeset government form). They keep a *worksheet* with the numbers
 * arranged so each cell maps to a known box on the rd.go.th web wizard, and
 * paste field-by-field. This file produces that worksheet.
 *
 * Sheet 1  Summary             — top-line numbers to paste into the web form
 * Sheet 2  Reconciliation      — accounting profit → taxable income (§65 ter)
 * Sheet 3  §65 ter detail      — per-category and per-line non-deductible add-back
 * Sheet 4  Tax brackets        — SME bracket math (covers PND.50 only)
 * Sheet 5  Credits             — WHT 1157 + PND.51 advance (PND.50 only)
 *
 * Filename:
 *   PND50_<fy>_<TIN13>_<branch6>.xlsx        for full-year
 *   PND51_<fy>_<TIN13>_<branch6>.xlsx        for half-year
 *
 * The form layout matches the RD web wizard at rd.go.th:
 *   - PND.51 boxes 1–13   (estimated half-year)
 *   - PND.50 boxes 1–35   (full year + adjustments + credits)
 */

export interface CitXlsxSenderConfig {
  payerTin: string;
  payerBranch: string;
  payerName: string;
}

export async function buildCitXlsx(
  preview: CitPreviewResult,
  sender: CitXlsxSenderConfig,
): Promise<{ filename: string; buffer: Buffer }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'erp-pos';
  wb.created = new Date();

  const formLabel = preview.halfYear ? 'PND.51' : 'PND.50';
  const formLabelTh = preview.halfYear ? 'ภ.ง.ด.51' : 'ภ.ง.ด.50';

  buildSummarySheet(wb, preview, sender, formLabel, formLabelTh);
  buildReconciliationSheet(wb, preview);
  buildNonDeductibleSheet(wb, preview);
  if (!preview.halfYear) {
    buildBracketsSheet(wb, preview);
    buildCreditsSheet(wb, preview);
  } else {
    // PND.51 doesn't claim WHT credits or PND.51-advances — skip those sheets,
    // but always include brackets so the user can see how H1 was projected.
    buildBracketsSheet(wb, preview);
  }

  const buf = await wb.xlsx.writeBuffer();
  const tin = onlyDigits(sender.payerTin, 13);
  const branch = sender.payerBranch.padStart(6, '0').slice(0, 6);
  const filename = `${formLabel.replace('.', '')}_${preview.fiscalYear}_${tin}_${branch}.xlsx`;
  return { filename, buffer: Buffer.from(buf) };
}

// ─── Sheet 1: Summary ───────────────────────────────────────────────────────
function buildSummarySheet(
  wb: ExcelJS.Workbook,
  p: CitPreviewResult,
  sender: CitXlsxSenderConfig,
  formLabel: string,
  formLabelTh: string,
) {
  const ws = wb.addWorksheet(`สรุป (${formLabelTh})`);
  ws.columns = [
    { header: 'ช่อง / Box', key: 'box', width: 14 },
    { header: 'รายการ / Field', key: 'label', width: 56 },
    { header: 'จำนวน (บาท) / Amount (THB)', key: 'value', width: 24 },
  ];

  const baht = (cents: number) => Number((cents / 100).toFixed(2));

  // Header block.
  ws.addRow(['', `${formLabel} — ${formLabelTh}`, '']).font = { bold: true, size: 14 };
  ws.addRow(['', 'แบบแสดงรายการภาษีเงินได้นิติบุคคล', '']).font = { bold: true };
  ws.addRow([]);

  ws.addRow(['', 'ผู้เสียภาษี / Taxpayer', sender.payerName]);
  ws.addRow(['', 'เลขประจำตัวผู้เสียภาษี / TIN', formatTinDisplay(sender.payerTin)]);
  ws.addRow(['', 'สาขา / Branch code', sender.payerBranch.padStart(6, '0')]);
  ws.addRow(['', 'รอบระยะเวลาบัญชี / Accounting period',
    `${p.periodFrom} – ${p.periodTo}`]);
  ws.addRow(['', 'ปีภาษี / Fiscal year (B.E.)', `${p.fiscalYear + 543} (พ.ศ.)`]);
  ws.addRow(['', 'ปีภาษี / Fiscal year (A.D.)', p.fiscalYear]);
  ws.addRow([]);

  ws.addRow(['', 'รายได้และรายจ่าย / Revenue and Expenses', '']).font = {
    bold: true,
  };
  ws.addRow(['1', 'รายได้รวม / Total revenue', baht(p.revenueCents)]);
  ws.addRow(['2', 'รายจ่ายรวม (ทางบัญชี) / Total expense (accounting)',
    baht(p.expenseCents)]);
  ws.addRow(['3', 'กำไรสุทธิทางบัญชี / Accounting net income',
    baht(p.accountingNetIncomeCents)]);
  ws.addRow([]);

  ws.addRow(['', 'การปรับปรุงตามมาตรา 65 ตรี / §65 ter adjustments', '']).font = {
    bold: true,
  };
  ws.addRow(['4', 'รายจ่ายที่ไม่ให้ถือเป็นรายจ่าย — บวกกลับ / Add-backs',
    baht(p.nonDeductibleCents)]);
  ws.addRow(['5', 'รายจ่ายที่ใช้คำนวณภาษี / Deductible expense',
    baht(p.deductibleExpenseCents)]);
  ws.addRow(['6', 'กำไรสุทธิที่ใช้เป็นฐานในการเสียภาษี / Taxable income',
    baht(p.taxableIncomeCents)]);
  ws.addRow([]);

  ws.addRow(['', 'การคำนวณภาษี / Tax calculation', '']).font = { bold: true };
  ws.addRow(['7', `อัตราภาษี / Rate bracket`,
    p.rateBracket === 'sme' ? 'SME (0/15/20%)' : 'Flat 20%']);
  if (p.halfYear) {
    ws.addRow(['8', 'รายได้ประมาณการรายปี / Annualised revenue (H1×2)',
      baht(p.annualisedRevenueCents)]);
  } else {
    ws.addRow(['8', 'รายได้รายปี / Annual revenue', baht(p.annualisedRevenueCents)]);
  }
  ws.addRow(['9', 'ทุนจดทะเบียนชำระแล้ว / Paid-in capital',
    baht(p.paidInCapitalCents)]);
  ws.addRow(['10', `ภาษีคำนวณได้ / Tax computed${p.halfYear ? ' (ครึ่งปี / half-year estimate)' : ''}`,
    baht(p.taxDueCents)]);
  ws.addRow([]);

  if (!p.halfYear) {
    ws.addRow(['', 'เครดิตภาษีและภาษีหัก ณ ที่จ่าย / Credits', '']).font = {
      bold: true,
    };
    ws.addRow(['11', 'ภาษีหัก ณ ที่จ่ายที่ถูกหักไว้ (1157) / WHT credits available',
      baht(p.whtCreditsCents)]);
    ws.addRow(['12', 'ภาษีที่ชำระตาม ภ.ง.ด.51 / PND.51 advance paid',
      baht(p.advancePaidCents)]);
    ws.addRow([]);
  }

  ws.addRow(['', 'ภาษีสุทธิ / Net Tax', '']).font = { bold: true };
  const netRow = ws.addRow([
    p.halfYear ? '11' : '13',
    'ภาษีสุทธิที่ต้องชำระ / Net tax payable',
    baht(p.netPayableCents),
  ]);
  netRow.font = { bold: true };
  netRow.getCell(3).numFmt = '"฿"#,##0.00';

  if (p.warnings.length > 0) {
    ws.addRow([]);
    const wRow = ws.addRow(['', 'คำเตือน / Warnings', '']);
    wRow.font = { bold: true, color: { argb: 'FFB45309' } };
    for (const warning of p.warnings) {
      ws.addRow(['', warning, '']);
    }
  }

  if (p.alreadyFiled && p.filing) {
    ws.addRow([]);
    const fRow = ws.addRow(['', 'สถานะ / Status', `Filed on ${p.filing.filedAt}`]);
    fRow.font = { bold: true, color: { argb: 'FF15803D' } };
    if (p.filing.rdFilingReference) {
      ws.addRow(['', 'RD reference', p.filing.rdFilingReference]);
    }
  }

  // Money formatting on column C, except a few non-money rows. Iterate rows 11+
  // and apply baht format only to numeric cells.
  ws.eachRow((row) => {
    const c = row.getCell(3);
    if (typeof c.value === 'number') c.numFmt = '#,##0.00';
  });

  ws.getRow(1).font = { bold: true };
  ws.getColumn(1).alignment = { horizontal: 'center' };
  ws.getColumn(3).alignment = { horizontal: 'right' };
}

// ─── Sheet 2: Reconciliation ────────────────────────────────────────────────
function buildReconciliationSheet(wb: ExcelJS.Workbook, p: CitPreviewResult) {
  const ws = wb.addWorksheet('กระทบยอดกำไรสุทธิ');
  ws.columns = [
    { header: 'รายการ / Step', key: 'label', width: 60 },
    { header: 'จำนวน (บาท)', key: 'value', width: 24 },
  ];
  const baht = (cents: number) => Number((cents / 100).toFixed(2));

  ws.addRow(['การกระทบยอดกำไรสุทธิทางบัญชีเป็นกำไรสุทธิทางภาษี', '']).font = {
    bold: true,
    size: 12,
  };
  ws.addRow(['Reconciliation: accounting net income → taxable income', '']).font =
    { italic: true };
  ws.addRow([]);
  ws.addRow(['(A) กำไรสุทธิทางบัญชี / Accounting net income',
    baht(p.accountingNetIncomeCents)]);
  ws.addRow(['(B) บวก: รายจ่ายที่ไม่ให้ถือเป็นรายจ่าย §65 ตรี / Add §65 ter non-deductible',
    baht(p.nonDeductibleCents)]);
  const totalRow = ws.addRow([
    '(C) กำไรสุทธิที่ใช้เป็นฐานในการเสียภาษี / Taxable income (= A + B)',
    baht(p.taxableIncomeCents),
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(2).numFmt = '"฿"#,##0.00';
  totalRow.eachCell((c) => {
    c.border = {
      top: { style: 'thin' },
      bottom: { style: 'double' },
    };
  });

  ws.addRow([]);
  ws.addRow([
    'หมายเหตุ: รายการบวกกลับตามมาตรา 65 ตรี ดูรายละเอียดในแผ่นงาน “รายละเอียด §65 ตรี”',
    '',
  ]).font = { italic: true, color: { argb: 'FF6B7280' } };

  ws.eachRow((row) => {
    const c = row.getCell(2);
    if (typeof c.value === 'number') c.numFmt = '#,##0.00';
  });
  ws.getRow(1).font = { bold: true };
  ws.getColumn(2).alignment = { horizontal: 'right' };
}

// ─── Sheet 3: §65 ter detail ────────────────────────────────────────────────
function buildNonDeductibleSheet(wb: ExcelJS.Workbook, p: CitPreviewResult) {
  const ws = wb.addWorksheet('รายละเอียด §65 ตรี');
  ws.columns = [
    { header: 'หมวด (TH) / Category (TH)', key: 'th', width: 38 },
    { header: 'หมวด (EN) / Category (EN)', key: 'en', width: 38 },
    { header: 'จำนวน (บาท)', key: 'cents', width: 18 },
  ];

  ws.getRow(1).font = { bold: true };

  // Always render every category — empty buckets just show 0.00. This makes
  // the worksheet directly comparable across periods at a glance.
  for (const cat of NON_DEDUCTIBLE_CATEGORIES as readonly NonDeductibleCategory[]) {
    const cents = p.nonDeductibleByCategory[cat] ?? 0;
    ws.addRow([
      CATEGORY_LABELS_TH[cat],
      CATEGORY_LABELS_EN[cat],
      Number((cents / 100).toFixed(2)),
    ]);
  }
  // Total row.
  const total = ws.addRow([
    'รวม / Total',
    'Sum of all §65 ter add-backs',
    Number((p.nonDeductibleCents / 100).toFixed(2)),
  ]);
  total.font = { bold: true };
  total.eachCell((c) => {
    c.border = {
      top: { style: 'thin' },
      bottom: { style: 'double' },
    };
  });

  ws.getColumn(3).alignment = { horizontal: 'right' };
  ws.getColumn(3).numFmt = '#,##0.00';
}

// ─── Sheet 4: Brackets ──────────────────────────────────────────────────────
function buildBracketsSheet(wb: ExcelJS.Workbook, p: CitPreviewResult) {
  const ws = wb.addWorksheet('ภาษีคำนวณ (Brackets)');
  ws.columns = [
    { header: 'ขั้น / Bracket', key: 'label', width: 40 },
    { header: 'ฐาน (บาท)', key: 'base', width: 20 },
    { header: 'อัตรา', key: 'rate', width: 12 },
    { header: 'ภาษี (บาท)', key: 'tax', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const b of p.breakdown) {
    ws.addRow([
      b.label,
      Number((b.baseCents / 100).toFixed(2)),
      `${(b.rate * 100).toFixed(0)}%`,
      Number((b.taxCents / 100).toFixed(2)),
    ]);
  }
  // Sub-total — full year computed
  const baht = (cents: number) => Number((cents / 100).toFixed(2));
  const total = ws.addRow([
    p.halfYear
      ? 'ภาษีคำนวณรายปี (ก่อนหารครึ่งปี) / Full-year computed'
      : 'รวม / Total',
    null,
    null,
    baht(
      p.halfYear
        ? p.taxDueCents * 2 // we halved earlier; restore for display
        : p.taxDueCents,
    ),
  ]);
  total.font = { bold: true };

  if (p.halfYear) {
    ws.addRow([
      'ภาษีครึ่งปี (= ÷2) / Half-year estimate (= ÷2)',
      null,
      null,
      baht(p.taxDueCents),
    ]).font = { bold: true, color: { argb: 'FF1D4ED8' } };
  }

  ws.getColumn(2).numFmt = '#,##0.00';
  ws.getColumn(2).alignment = { horizontal: 'right' };
  ws.getColumn(4).numFmt = '#,##0.00';
  ws.getColumn(4).alignment = { horizontal: 'right' };
}

// ─── Sheet 5: Credits (PND.50 only) ─────────────────────────────────────────
function buildCreditsSheet(wb: ExcelJS.Workbook, p: CitPreviewResult) {
  const ws = wb.addWorksheet('เครดิตภาษี (Credits)');
  ws.columns = [
    { header: 'รายการ / Item', key: 'label', width: 56 },
    { header: 'จำนวน (บาท)', key: 'value', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };

  const baht = (cents: number) => Number((cents / 100).toFixed(2));

  ws.addRow([
    'ภาษีคำนวณได้ / Tax computed (full year)',
    baht(p.taxDueCents),
  ]);
  ws.addRow([
    'หัก: ภาษีหัก ณ ที่จ่ายสะสม (บัญชี 1157) / WHT credits available',
    -baht(p.whtCreditsCents),
  ]);
  ws.addRow([
    'หัก: ภาษีที่ชำระตาม ภ.ง.ด.51 / PND.51 advance paid',
    -baht(p.advancePaidCents),
  ]);
  const net = ws.addRow([
    'ภาษีสุทธิที่ต้องชำระ / Net tax payable',
    baht(p.netPayableCents),
  ]);
  net.font = { bold: true };
  net.getCell(2).numFmt = '"฿"#,##0.00';
  net.eachCell((c) => {
    c.border = {
      top: { style: 'thin' },
      bottom: { style: 'double' },
    };
  });

  if (p.netPayableCents < 0) {
    ws.addRow([]);
    ws.addRow([
      'หมายเหตุ: ตัวเลขสุทธิติดลบ — มีสิทธิขอคืนภาษี / Note: negative net = refund claimable',
      '',
    ]).font = { italic: true, color: { argb: 'FF15803D' } };
  }

  ws.getColumn(2).numFmt = '#,##0.00';
  ws.getColumn(2).alignment = { horizontal: 'right' };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * v2.0-style digit normaliser — zero-pads short input. Local because the v1.0
 * variant returns '' for empty (semantic divergence — see pnd-rd-v1.ts).
 */
function onlyDigits(s: string, n: number): string {
  const d = (s || '').replace(/\D/g, '');
  if (d.length === n) return d;
  if (d.length > n) return d.slice(-n);
  return d.padStart(n, '0');
}
