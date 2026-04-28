import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import * as path from 'node:path';
import * as fs from 'node:fs';
import PDFDocument from 'pdfkit';
import type { Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * 🇹🇭 รายงานสินค้าและวัตถุดิบ (Daily Inventory & Goods Report)
 * per RD Director-General Notice No. 89 §9.
 *
 * Statutory minimum 3 cols (must be present, in Thai):
 *   วัน-เดือน-ปี | ปริมาณรับ-จ่าย | มูลค่ารับ-จ่าย
 *   (date)         (qty in/out)        (value in/out)
 *
 * Soft-required extras (good practice, not strictly mandated):
 *   SKU, document reference, unit cost, running balance per product.
 *
 * Cadence: ≤T+3 business days. Daily summary preferred. Thai-language
 * mandatory; PDF/A export for DBD audit. Retention 5 yrs (§87/3).
 *
 * Source of truth: stock_moves ledger aggregated by (date, product_id, branch_code).
 * Aggregation respects move_type sign (sale/damage/expire negative; receive
 * positive; transfers cancel out at the org level but show per-warehouse).
 */
export interface GoodsReportRow {
  /** ISO date yyyy-mm-dd */
  date: string;
  branchCode: string;
  productId: string;
  productName: string;
  sku: string | null;
  qtyIn: number;
  qtyOut: number;
  valueInCents: number;
  valueOutCents: number;
  runningBalance: number;
}

export interface GoodsReportSummary {
  fromDate: string;
  toDate: string;
  branchCode: string | null;
  totalQtyIn: number;
  totalQtyOut: number;
  totalValueInCents: number;
  totalValueOutCents: number;
  rowCount: number;
}

@Injectable()
export class GoodsReportService {
  private readonly logger = new Logger(GoodsReportService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Fetch the per-day, per-product, per-branch goods report for a date range.
   * Each row aggregates all stock_moves on that date for that (product, branch).
   *
   * IN: receive + transfer_in + cycle_count_adjust positive + refund (return to stock)
   * OUT: sale + damage + expire + transfer_out + cycle_count_adjust negative
   */
  async getReport(opts: {
    fromDate: string; // yyyy-mm-dd
    toDate: string; // yyyy-mm-dd
    branchCode?: string;
  }): Promise<{ rows: GoodsReportRow[]; summary: GoodsReportSummary }> {
    const { fromDate, toDate, branchCode } = opts;

    const result = await this.db.execute<{
      date: string;
      branch_code: string;
      product_id: string;
      product_name: string;
      sku: string | null;
      qty_in: string;
      qty_out: string;
      value_in_cents: string;
      value_out_cents: string;
    }>(sql`
      WITH moves AS (
        SELECT
          DATE(performed_at AT TIME ZONE 'Asia/Bangkok') AS day,
          COALESCE(branch_code, '00000') AS branch_code,
          product_id,
          qty::numeric AS qty,
          COALESCE(unit_cost_cents, 0) AS unit_cost_cents
        FROM custom.stock_moves
        WHERE performed_at >= ${fromDate}::date AT TIME ZONE 'Asia/Bangkok'
          AND performed_at <  (${toDate}::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok'
          ${branchCode ? sql`AND COALESCE(branch_code, '00000') = ${branchCode}` : sql``}
      )
      SELECT
        m.day::text AS date,
        m.branch_code,
        m.product_id::text AS product_id,
        p.name AS product_name,
        p.sku,
        SUM(GREATEST(m.qty, 0))::text AS qty_in,
        SUM(GREATEST(-m.qty, 0))::text AS qty_out,
        SUM(CASE WHEN m.qty > 0 THEN m.qty * m.unit_cost_cents ELSE 0 END)::text AS value_in_cents,
        SUM(CASE WHEN m.qty < 0 THEN -m.qty * m.unit_cost_cents ELSE 0 END)::text AS value_out_cents
      FROM moves m
      LEFT JOIN custom.products p ON p.id = m.product_id
      GROUP BY m.day, m.branch_code, m.product_id, p.name, p.sku
      ORDER BY m.day, m.branch_code, p.name
    `);

    const rowsRaw = ((result as any).rows ?? (result as any)) as Array<any>;

    // Compute running balance per product across the date range (single-pass).
    const balances = new Map<string, number>();
    const rows: GoodsReportRow[] = rowsRaw.map((r) => {
      const qIn = Number(r.qty_in);
      const qOut = Number(r.qty_out);
      const prev = balances.get(r.product_id) ?? 0;
      const newBal = prev + qIn - qOut;
      balances.set(r.product_id, newBal);
      return {
        date: r.date,
        branchCode: r.branch_code,
        productId: r.product_id,
        productName: r.product_name ?? '(unknown)',
        sku: r.sku,
        qtyIn: qIn,
        qtyOut: qOut,
        valueInCents: Math.round(Number(r.value_in_cents)),
        valueOutCents: Math.round(Number(r.value_out_cents)),
        runningBalance: newBal,
      };
    });

    const summary: GoodsReportSummary = {
      fromDate,
      toDate,
      branchCode: branchCode ?? null,
      totalQtyIn: rows.reduce((s, r) => s + r.qtyIn, 0),
      totalQtyOut: rows.reduce((s, r) => s + r.qtyOut, 0),
      totalValueInCents: rows.reduce((s, r) => s + r.valueInCents, 0),
      totalValueOutCents: rows.reduce((s, r) => s + r.valueOutCents, 0),
      rowCount: rows.length,
    };

    return { rows, summary };
  }

  /**
   * CSV export — tab-separated, UTF-8 with BOM so Excel opens Thai correctly.
   * Statutory 3 cols + soft extras. Header in Thai per Notice 89.
   */
  toCsv(rows: GoodsReportRow[]): string {
    const header = [
      'วันที่',
      'สาขา',
      'รหัสสินค้า',
      'ชื่อสินค้า',
      'ปริมาณรับ',
      'ปริมาณจ่าย',
      'มูลค่ารับ (สตางค์)',
      'มูลค่าจ่าย (สตางค์)',
      'ยอดคงเหลือ',
    ].join(',');

    const lines = rows.map((r) =>
      [
        r.date,
        r.branchCode,
        r.sku ?? '',
        '"' + (r.productName ?? '').replace(/"/g, '""') + '"',
        r.qtyIn.toFixed(3),
        r.qtyOut.toFixed(3),
        r.valueInCents.toString(),
        r.valueOutCents.toString(),
        r.runningBalance.toFixed(3),
      ].join(','),
    );

    // BOM so Excel renders Thai characters correctly.
    return '﻿' + header + '\n' + lines.join('\n');
  }

  /**
   * 🇹🇭 PDF export — Thai-language report rendered with embedded Sarabun
   * (OFL-licensed) so DBD audit reviewers can open it on any platform without
   * installing Thai fonts.
   *
   * This is "PDF" not strict "PDF/A-3" (PDF/A-3 requires XMP metadata + ICC
   * profile + embedded XSDs — Phase 4 archival territory). The format is
   * accepted by DBD electronic-books filing per §8.5 of knowledge.md.
   */
  async toPdf(
    summary: GoodsReportSummary,
    rows: GoodsReportRow[],
    sellerInfo: { name: string; tin?: string | null; branchCode?: string | null },
  ): Promise<Buffer> {
    const fontDir = this.resolveFontDir();
    const regular = path.join(fontDir, 'Sarabun-Regular.ttf');
    const bold = path.join(fontDir, 'Sarabun-Bold.ttf');

    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      info: {
        Title: 'รายงานสินค้าและวัตถุดิบ',
        Author: sellerInfo.name,
        Subject: `Goods Report ${summary.fromDate} → ${summary.toDate}`,
        Producer: 'ERP-POS',
      },
    });

    if (fs.existsSync(regular)) doc.registerFont('TH', regular);
    if (fs.existsSync(bold)) doc.registerFont('TH-Bold', bold);

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // Header
    doc.font('TH-Bold').fontSize(16).text('รายงานสินค้าและวัตถุดิบ', { align: 'center' });
    doc
      .font('TH')
      .fontSize(9)
      .text('Goods & Raw Materials Daily Report (RD Notice No. 89 §9)', {
        align: 'center',
      });
    doc.moveDown(0.5);

    // Seller block
    doc.font('TH-Bold').fontSize(10).text(sellerInfo.name);
    doc.font('TH').fontSize(9);
    if (sellerInfo.tin) {
      doc.text(`เลขประจำตัวผู้เสียภาษี: ${formatTin(sellerInfo.tin)}  สาขา: ${sellerInfo.branchCode ?? '00000'}`);
    }
    doc.text(`ช่วงรายงาน: ${summary.fromDate} ถึง ${summary.toDate}`);
    if (summary.branchCode) doc.text(`สาขา: ${summary.branchCode}`);
    doc.moveDown(0.5);

    // Summary line
    doc
      .font('TH-Bold')
      .fontSize(9)
      .text(
        `รวมรับ ${summary.totalQtyIn.toFixed(3)}  รวมจ่าย ${summary.totalQtyOut.toFixed(3)}  มูลค่ารับ ${(
          summary.totalValueInCents / 100
        ).toLocaleString('th-TH', { minimumFractionDigits: 2 })}  มูลค่าจ่าย ${(
          summary.totalValueOutCents / 100
        ).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
      );
    doc.moveDown(0.5);

    // Table
    const cols = [
      { label: 'วันที่', width: 60 },
      { label: 'สาขา', width: 35 },
      { label: 'รหัส', width: 50 },
      { label: 'ชื่อสินค้า', width: 130 },
      { label: 'รับ', width: 45, align: 'right' as const },
      { label: 'จ่าย', width: 45, align: 'right' as const },
      { label: 'ม.รับ', width: 60, align: 'right' as const },
      { label: 'ม.จ่าย', width: 60, align: 'right' as const },
      { label: 'คงเหลือ', width: 50, align: 'right' as const },
    ];

    const drawHeader = () => {
      doc.font('TH-Bold').fontSize(8);
      let x = doc.page.margins.left;
      const y = doc.y;
      for (const c of cols) {
        doc.text(c.label, x, y, { width: c.width, align: c.align ?? 'left' });
        x += c.width;
      }
      doc.moveDown(0.3);
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.2);
    };

    drawHeader();

    doc.font('TH').fontSize(8);
    for (const r of rows) {
      // Page break when near bottom margin
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        drawHeader();
      }
      const cells = [
        r.date,
        r.branchCode,
        r.sku ?? '',
        r.productName ?? '(unknown)',
        r.qtyIn.toFixed(3),
        r.qtyOut.toFixed(3),
        (r.valueInCents / 100).toFixed(2),
        (r.valueOutCents / 100).toFixed(2),
        r.runningBalance.toFixed(3),
      ];
      let x = doc.page.margins.left;
      const y = doc.y;
      for (let i = 0; i < cols.length; i++) {
        doc.text(cells[i] ?? '', x, y, {
          width: cols[i].width,
          align: cols[i].align ?? 'left',
        });
        x += cols[i].width;
      }
      doc.moveDown(0.5);
    }

    // Footer with retention notice
    if (doc.y > doc.page.height - doc.page.margins.bottom - 50) {
      doc.addPage();
    }
    doc.moveDown(1);
    doc
      .font('TH')
      .fontSize(7)
      .fillColor('#666')
      .text(
        'เอกสารนี้สร้างโดยระบบ ERP-POS  •  ระยะเวลาเก็บรักษา 5 ปี (มาตรา 87/3 ประมวลรัษฎากร)',
        { align: 'center' },
      );

    doc.end();
    return await done;
  }

  /** Resolve the assets/fonts directory whether running from src/ (dev) or dist/ (prod). */
  private resolveFontDir(): string {
    // Production: dist/assets/fonts/ (copied by nest-cli `assets` rule)
    const prod = path.join(__dirname, '..', '..', 'assets', 'fonts');
    if (fs.existsSync(prod)) return prod;
    // Dev (ts-node / vitest): src/assets/fonts/
    const dev = path.join(__dirname, '..', '..', '..', 'src', 'assets', 'fonts');
    if (fs.existsSync(dev)) return dev;
    this.logger.warn(
      `Sarabun font directory not found at ${prod} or ${dev} — Thai chars will fall back to default`,
    );
    return prod;
  }
}

function formatTin(tin: string): string {
  const digits = tin.replace(/\D/g, '');
  if (digits.length !== 13) return tin;
  return `${digits[0]}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits[12]}`;
}
