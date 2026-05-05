import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lt, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { bahtPlain as toBaht, csvSafe } from './_format.util';

/**
 * 🇹🇭 Phor.Por.30 — Monthly VAT Return.
 *
 * RD form boxes we compute from POS sales (purchase side is Phase 4 accounting):
 *   Box 1   ยอดขายที่ต้องเสียภาษี          — taxable sales net
 *   Box 2   ยอดขายที่เสียภาษีในอัตราร้อยละ 0 — zero-rated sales net
 *   Box 3   ยอดขายที่ได้รับยกเว้น            — exempt sales net
 *   Box 4   ยอดขายรวม                      — box 1 + 2 + 3
 *   Box 5   ภาษีขาย                         — output VAT (sum of vat_breakdown.vatCents)
 *
 * This service returns the per-month aggregate. A UI + CSV endpoint consume it.
 * Purchase-side boxes (6–9, including credit-note adjustments) are left as 0
 * until the accounting module comes online in Phase 4.
 */

/**
 * 🇹🇭 Merchant header block for the PP.30 XLSX (effective 2026-03-01 layout).
 * Optional — when omitted the XLSX skips the seller block and renders the
 * legacy summary-only sheet.
 *
 * `promptpayRefundId`: per the 2026-03-01 form revision, RD refunds VAT
 * credits via PromptPay linked to the merchant's TIN. Format is either the
 * merchant TIN (13 digits) or a registered E.164 mobile (+66...).
 */
export interface PP30MerchantHeader {
  sellerName: string;
  sellerTin: string | null;
  sellerBranch: string;
  sellerAddress: string;
  promptpayRefundId: string | null;
}

export interface PP30Month {
  period: string; // YYYYMM
  taxableSalesNetCents: number;
  zeroRatedSalesNetCents: number;
  exemptSalesNetCents: number;
  outputVatCents: number;
  totalSalesNetCents: number;
  // Credit notes (refunds/voids) in the period reduce output VAT — RD requires
  // them to appear on the same PP.30 form as a negative line.
  creditNoteAdjustmentCents: number;
  refundedVatCents: number;
  net: {
    outputVatAfterCN: number;
  };
  source: {
    orderCount: number;
    creditNoteCount: number;
  };
}

@Injectable()
export class PP30Service {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async forMonth(year: number, month: number): Promise<PP30Month> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const period = `${year}${String(month).padStart(2, '0')}`;

    const rows = await this.db
      .select()
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)));

    let taxable = 0;
    let zero = 0;
    let exempt = 0;
    let vat = 0;
    let cnAdj = 0;
    let refundedVat = 0;
    let orderCount = 0;
    let cnCount = 0;

    for (const row of rows) {
      const vb = (row.vatBreakdown ?? {}) as {
        taxableNetCents?: number;
        zeroRatedNetCents?: number;
        exemptNetCents?: number;
        vatCents?: number;
      };

      if (row.documentType === 'CN') {
        cnCount += 1;
        cnAdj += Math.abs(row.totalCents ?? 0);
        refundedVat += Math.abs(vb.vatCents ?? 0);
        // Reduce the corresponding sale buckets by the CN magnitude.
        taxable -= Math.abs(vb.taxableNetCents ?? 0);
        zero -= Math.abs(vb.zeroRatedNetCents ?? 0);
        exempt -= Math.abs(vb.exemptNetCents ?? 0);
        vat -= Math.abs(vb.vatCents ?? 0);
      } else {
        orderCount += 1;
        taxable += vb.taxableNetCents ?? 0;
        zero += vb.zeroRatedNetCents ?? 0;
        exempt += vb.exemptNetCents ?? 0;
        vat += vb.vatCents ?? 0;
      }
    }

    return {
      period,
      taxableSalesNetCents: taxable,
      zeroRatedSalesNetCents: zero,
      exemptSalesNetCents: exempt,
      outputVatCents: vat + refundedVat, // gross output VAT before CN credit
      totalSalesNetCents: taxable + zero + exempt,
      creditNoteAdjustmentCents: cnAdj,
      refundedVatCents: refundedVat,
      net: { outputVatAfterCN: vat },
      source: { orderCount, creditNoteCount: cnCount },
    };
  }

  async monthlySalesRows(year: number, month: number) {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    return this.db
      .select({
        id: posOrders.id,
        docType: posOrders.documentType,
        docNumber: posOrders.documentNumber,
        date: posOrders.createdAt,
        buyerTin: posOrders.buyerTin,
        buyerName: posOrders.buyerName,
        subtotalCents: posOrders.subtotalCents,
        taxCents: posOrders.taxCents,
        totalCents: posOrders.totalCents,
        vatBreakdown: posOrders.vatBreakdown,
        status: posOrders.status,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)))
      .orderBy(sql`${posOrders.documentNumber} asc`);
  }

  async monthlyXlsx(
    year: number,
    month: number,
    merchant?: PP30MerchantHeader,
  ): Promise<Buffer> {
    const [summary, rows] = await Promise.all([
      this.forMonth(year, month),
      this.monthlySalesRows(year, month),
    ]);
    return pp30ToXlsx(summary, rows, merchant);
  }

  async monthlySalesCsv(year: number, month: number): Promise<string> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));

    const rows = await this.db
      .select({
        id: posOrders.id,
        docType: posOrders.documentType,
        docNumber: posOrders.documentNumber,
        date: posOrders.createdAt,
        buyerTin: posOrders.buyerTin,
        buyerName: posOrders.buyerName,
        subtotalCents: posOrders.subtotalCents,
        taxCents: posOrders.taxCents,
        totalCents: posOrders.totalCents,
        vatBreakdown: posOrders.vatBreakdown,
        status: posOrders.status,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)))
      .orderBy(sql`${posOrders.documentNumber} asc`);

    const header = [
      'doc_type',
      'doc_number',
      'date',
      'buyer_tin',
      'buyer_name',
      'taxable_net_baht',
      'zero_rated_net_baht',
      'exempt_net_baht',
      'vat_baht',
      'total_baht',
      'status',
    ].join(',');

    const lines = rows.map((r) => {
      const vb = (r.vatBreakdown ?? {}) as {
        taxableNetCents?: number;
        zeroRatedNetCents?: number;
        exemptNetCents?: number;
        vatCents?: number;
      };
      // CN rows are already stored with negative amounts — surface as-is so
      // RD filings show the credit-note as a subtracting line.
      return [
        r.docType ?? '',
        r.docNumber ?? '',
        r.date?.toISOString() ?? '',
        r.buyerTin ?? '',
        csvSafe(r.buyerName ?? ''),
        toBaht(vb.taxableNetCents ?? 0),
        toBaht(vb.zeroRatedNetCents ?? 0),
        toBaht(vb.exemptNetCents ?? 0),
        toBaht(vb.vatCents ?? 0),
        toBaht(r.totalCents ?? 0),
        r.status ?? '',
      ].join(',');
    });

    return [header, ...lines].join('\n');
  }
}

// ─── XLSX export (RD-compliant layout) ────────────────────────────────────
// Extends PP30Service via a method added below. Placed outside the class
// declaration only to keep the change local — the TS compiler accepts method
// augmentation of PP30Service via a `declare module` or a prototype patch,
// but the simpler pattern for our single-file service is to add the method
// inline via another injected constructor. For now we expose a plain function
// that takes the service result + raw rows.

export async function pp30ToXlsx(
  summary: {
    period: string;
    taxableSalesNetCents: number;
    zeroRatedSalesNetCents: number;
    exemptSalesNetCents: number;
    outputVatCents: number;
    refundedVatCents: number;
    net: { outputVatAfterCN: number };
  },
  rows: Array<{
    docType: string | null;
    docNumber: string | null;
    date: Date | null;
    buyerTin: string | null;
    buyerName: string | null;
    vatBreakdown: unknown;
    totalCents: number | null;
    status: string | null;
  }>,
  merchant?: PP30MerchantHeader,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERP-POS';
  wb.created = new Date();

  // Sheet 1: PP.30 summary (the form boxes)
  const s = wb.addWorksheet('ภ.พ.30 สรุป');
  s.columns = [
    { header: 'รายการ', key: 'label', width: 56 },
    { header: 'บาท', key: 'amount', width: 18, style: { numFmt: '#,##0.00' } },
  ];
  s.getRow(1).font = { bold: true };

  // 🇹🇭 2026-03-01 layout — merchant identity header. Renders before the
  // form boxes so the printed PP.30 matches the new RD form sequence
  // (merchant block → form boxes → input/output VAT split → refund channel).
  if (merchant) {
    s.addRow({ label: '— ผู้ประกอบการ / MERCHANT —', amount: '' });
    s.addRow({ label: `ชื่อ:                        ${merchant.sellerName}`, amount: '' });
    if (merchant.sellerTin) {
      s.addRow({
        label: `เลขประจำตัวผู้เสียภาษี:    ${merchant.sellerTin}  สาขา ${merchant.sellerBranch}`,
        amount: '',
      });
    }
    if (merchant.sellerAddress) {
      s.addRow({ label: `ที่อยู่:                     ${merchant.sellerAddress}`, amount: '' });
    }
    s.addRow({ label: '', amount: '' });
  }

  s.addRow({ label: `เดือนภาษี: ${summary.period}`, amount: '' });
  s.addRow({ label: 'กล่อง 1 — ยอดขายที่ต้องเสียภาษี', amount: summary.taxableSalesNetCents / 100 });
  s.addRow({ label: 'กล่อง 2 — ยอดขายอัตรา 0%', amount: summary.zeroRatedSalesNetCents / 100 });
  s.addRow({ label: 'กล่อง 3 — ยอดขายที่ยกเว้น', amount: summary.exemptSalesNetCents / 100 });
  s.addRow({
    label: 'กล่อง 4 — ยอดขายรวม',
    amount:
      (summary.taxableSalesNetCents + summary.zeroRatedSalesNetCents + summary.exemptSalesNetCents) / 100,
  });
  s.addRow({ label: 'กล่อง 5 — ภาษีขาย (gross, pre-CN)', amount: summary.outputVatCents / 100 });
  s.addRow({ label: '   หัก ภาษีขายที่คืน (CN adjustments)', amount: -summary.refundedVatCents / 100 });
  s.addRow({ label: '   ภาษีขายสุทธิ', amount: summary.net.outputVatAfterCN / 100 });

  // 🇹🇭 2026-03-01 layout — refund channel block. RD refunds VAT credits to
  // a PromptPay ID linked to the merchant TIN. Render even when not set
  // (with an explicit "—") so accountants notice it's missing.
  if (merchant) {
    s.addRow({ label: '', amount: '' });
    s.addRow({ label: '— ช่องทางคืนเงิน VAT (PromptPay) / VAT REFUND CHANNEL —', amount: '' });
    s.addRow({
      label: `PromptPay ID:                ${merchant.promptpayRefundId ?? '— (ยังไม่กำหนด — ตั้งค่าใน Settings)'}`,
      amount: '',
    });
  }

  // Sheet 2: per-document detail
  const d = wb.addWorksheet('รายละเอียด');
  d.columns = [
    { header: 'ประเภท', key: 'docType', width: 8 },
    { header: 'เลขที่', key: 'docNumber', width: 22 },
    { header: 'วันที่', key: 'date', width: 22 },
    { header: 'TIN ผู้ซื้อ', key: 'buyerTin', width: 18 },
    { header: 'ชื่อผู้ซื้อ', key: 'buyerName', width: 28 },
    { header: 'มูลค่า (ไม่รวม VAT)', key: 'taxable', width: 18, style: { numFmt: '#,##0.00' } },
    { header: 'อัตรา 0%', key: 'zeroRated', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'ยกเว้น', key: 'exempt', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'ภาษีขาย', key: 'vat', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'รวม', key: 'total', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'สถานะ', key: 'status', width: 12 },
  ];
  d.getRow(1).font = { bold: true };

  for (const r of rows) {
    const vb = (r.vatBreakdown ?? {}) as {
      taxableNetCents?: number;
      zeroRatedNetCents?: number;
      exemptNetCents?: number;
      vatCents?: number;
    };
    d.addRow({
      docType: r.docType ?? '',
      docNumber: r.docNumber ?? '',
      date: r.date ? r.date.toISOString() : '',
      buyerTin: r.buyerTin ?? '',
      buyerName: r.buyerName ?? '',
      taxable: (vb.taxableNetCents ?? 0) / 100,
      zeroRated: (vb.zeroRatedNetCents ?? 0) / 100,
      exempt: (vb.exemptNetCents ?? 0) / 100,
      vat: (vb.vatCents ?? 0) / 100,
      total: (r.totalCents ?? 0) / 100,
      status: r.status ?? '',
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
