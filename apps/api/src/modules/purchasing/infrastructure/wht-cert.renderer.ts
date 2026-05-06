import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as path from 'node:path';
import * as fs from 'node:fs';
import PDFDocument from 'pdfkit';
import {
  bahtTextFromSatang,
  formatTIN,
  guessTINKind,
} from '@erp/shared';
import {
  partners,
  vendorBillLines,
  vendorBills,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { OrganizationService } from '../../organization/organization.service';
import { PurchasingSequenceService } from './purchasing-sequence.service';
import { whtRateBp } from '../domain/wht';

/**
 * 🇹🇭 50-Tawi (หนังสือรับรองการหักภาษี ณ ที่จ่าย)
 *
 * Per Revenue Code §50 ทวิ — the certificate the *withholder* (us, paying a
 * vendor) gives to the *withholdee* (the supplier) so the supplier can claim
 * the withheld amount as a credit against their own tax liability.
 *
 * Layout follows the RD frm_WTC.pdf template. The PDF is "valid for use" once
 * we as withholder sign it; we render the prepared form as a PDF that the
 * AP team prints, signs, and hands to the supplier with the payment.
 *
 * One certificate per bill that has wht_cents > 0. The bill must already be
 * paid (so paidDate is the payment-date that determines tax-point for WHT).
 */
@Injectable()
export class WhtCertificateRenderer {
  private readonly logger = new Logger(WhtCertificateRenderer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly sequences: PurchasingSequenceService,
  ) {}

  async renderForBill(billId: string): Promise<Buffer> {
    // 1. Pull bill + lines + supplier + seller.
    const [bill] = await this.db
      .select()
      .from(vendorBills)
      .where(eq(vendorBills.id, billId))
      .limit(1);
    if (!bill) {
      throw new NotFoundException(`Bill ${billId} not found`);
    }
    if (Number(bill.whtCents ?? 0) <= 0) {
      throw new NotFoundException(
        `Bill ${bill.internalNumber} has no withholding tax — no 50-Tawi to issue`,
      );
    }
    const lines = await this.db
      .select()
      .from(vendorBillLines)
      .where(eq(vendorBillLines.vendorBillId, billId))
      .orderBy(vendorBillLines.lineNo);
    const [supplier] = await this.db
      .select()
      .from(partners)
      .where(eq(partners.id, bill.supplierId))
      .limit(1);
    if (!supplier) {
      throw new NotFoundException(`Supplier ${bill.supplierId} not found`);
    }
    const seller = await this.org.snapshot();

    // 2. Aggregate WHT lines by category. Most bills have one category; allow
    //    multiple (a bill that mixes services + rent → two rows on the cert).
    const grouped = new Map<
      string,
      { netCents: number; whtCents: number; rateBp: number; descriptions: string[] }
    >();
    for (const l of lines) {
      const cat = l.whtCategory;
      if (!cat) continue;
      const wht = Number(l.whtCents ?? 0);
      if (wht <= 0) continue;
      const cur = grouped.get(cat) ?? {
        netCents: 0,
        whtCents: 0,
        rateBp: l.whtRateBp ?? whtRateBp(cat as any),
        descriptions: [],
      };
      cur.netCents += Number(l.netCents ?? 0);
      cur.whtCents += wht;
      cur.descriptions.push(l.description);
      grouped.set(cat, cur);
    }
    if (grouped.size === 0) {
      throw new NotFoundException(
        `Bill ${bill.internalNumber} stores wht_cents but no line carries a wht_category`,
      );
    }

    const totalNet = Array.from(grouped.values()).reduce(
      (s, g) => s + g.netCents,
      0,
    );
    const totalWht = Array.from(grouped.values()).reduce(
      (s, g) => s + g.whtCents,
      0,
    );
    const paidDate = bill.paidAt
      ? bill.paidAt.toISOString().slice(0, 10)
      : bill.billDate;

    // 3. Render.
    const fontDir = this.resolveFontDir();
    const reg = path.join(fontDir, 'Sarabun-Regular.ttf');
    const bold = path.join(fontDir, 'Sarabun-Bold.ttf');

    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      info: {
        Title: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย',
        Author: seller.sellerName,
        Subject: `50-Tawi for ${bill.internalNumber}`,
        Producer: 'ERP-POS',
      },
    });
    if (fs.existsSync(reg)) doc.registerFont('TH', reg);
    if (fs.existsSync(bold)) doc.registerFont('TH-Bold', bold);

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // Allocate WHT-YYMM-###### sequence number (idempotent per bill — if the
    // cert is re-printed, a new sequence number is assigned; this is intentional
    // since Thai practice allows duplicate-original prints with fresh seq #).
    const certSeq = await this.sequences.allocate('WHT', new Date());
    const certNumber = certSeq.number; // e.g. WHT2604-000001

    // ── Header ────────────────────────────────────────────────────────────
    doc.font('TH-Bold').fontSize(15).text('หนังสือรับรองการหักภาษี ณ ที่จ่าย', {
      align: 'center',
    });
    doc.font('TH').fontSize(9).text('(ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร)', {
      align: 'center',
    });
    doc.moveDown(0.4);
    doc
      .font('TH')
      .fontSize(8)
      .fillColor('#666')
      .text(
        `เลขที่ / Cert No.: ${certNumber}    เลขที่อ้างอิง / Reference: ${bill.internalNumber}    ออกเมื่อ / Issued: ${paidDate}`,
        { align: 'center' },
      )
      .fillColor('#000');
    doc.moveDown(0.6);

    // ── Box 1 — withholder (us) ───────────────────────────────────────────
    this.box(
      doc,
      'ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (Withholder)',
      [
        ['ชื่อ', seller.sellerName || '-'],
        ['เลขประจำตัวผู้เสียภาษี', seller.sellerTin ? formatTIN(seller.sellerTin) : '-'],
        ['สาขา', seller.sellerBranch || '00000'],
        ['ที่อยู่', seller.sellerAddress || '-'],
      ],
    );

    // ── Box 2 — withholdee (supplier) ─────────────────────────────────────
    const addr = supplier.address as Record<string, unknown> | null;
    const addressString = addr
      ? [addr.line1, addr.line2, addr.district, addr.province, addr.postalCode]
          .filter((x) => typeof x === 'string' && x.length > 0)
          .join(' ')
      : '-';
    const supplierKind = supplier.tin ? guessTINKind(supplier.tin) : 'foreign';
    this.box(
      doc,
      'ผู้ถูกหักภาษี ณ ที่จ่าย (Withholdee)',
      [
        ['ชื่อ', supplier.legalName || supplier.name],
        [
          'เลขประจำตัวผู้เสียภาษี',
          supplier.tin ? formatTIN(supplier.tin) : '(ไม่มี — ผู้รับเงินอยู่ต่างประเทศ)',
        ],
        ['สาขา', supplier.branchCode || '00000'],
        ['ที่อยู่', addressString],
        [
          'ประเภท',
          supplierKind === 'juristic'
            ? 'นิติบุคคล (PND.53)'
            : supplierKind === 'citizen'
            ? 'บุคคลธรรมดา (PND.3)'
            : 'ผู้รับต่างประเทศ (PND.54)',
        ],
      ],
    );

    // ── Section: payment-type checkboxes (which RD section we're paying under) ─
    // Tickboxes are drawn as vector rectangles + X-mark instead of Unicode
    // U+2611/U+2610 chars, because Sarabun (and most Thai fonts) lack those
    // glyphs and they render as tiny undefined squares.
    doc.moveDown(0.4);
    doc.font('TH-Bold').fontSize(9).text('ประเภทเงินที่จ่าย:');
    doc.font('TH').fontSize(9);
    const isCategory = (
      cat:
        | 'services'
        | 'rent'
        | 'ads'
        | 'freight'
        | 'dividends'
        | 'interest'
        | 'foreign',
    ) => grouped.has(cat);
    this.tickboxLine(doc, '1. เงินเดือน ค่าจ้าง (มาตรา 40(1))', false);
    this.tickboxLine(
      doc,
      '2. ค่าธรรมเนียม ค่านายหน้า ค่าโฆษณา (มาตรา 40(2))',
      isCategory('services') || isCategory('ads'),
    );
    this.tickboxLine(doc, '3. ค่าแห่งลิขสิทธิ์ กู๊ดวิลล์ (มาตรา 40(3))', false);
    this.tickboxLine(doc, '4(ก). ดอกเบี้ย (มาตรา 40(4)(ก))', isCategory('interest'));
    this.tickboxLine(doc, '4(ข). เงินปันผล (มาตรา 40(4)(ข))', isCategory('dividends'));
    this.tickboxLine(doc, '5. การจ่ายให้ผู้รับในต่างประเทศ (มาตรา 70)', isCategory('foreign'));
    this.tickboxLine(doc, '6. ค่าเช่าทรัพย์สิน (มาตรา 40(5))', isCategory('rent'));
    this.tickboxLine(
      doc,
      '7. อื่นๆ — ค่าจ้างทำของ ค่าบริการ ค่าขนส่ง',
      isCategory('services') || isCategory('freight'),
    );
    doc.moveDown(0.4);

    // ── Detail table ──────────────────────────────────────────────────────
    const cols = [
      { label: 'วันที่จ่าย', width: 80 },
      { label: 'ประเภท / รายการ', width: 220 },
      { label: 'จำนวนเงิน (บาท)', width: 90, align: 'right' as const },
      { label: 'อัตรา %', width: 50, align: 'right' as const },
      { label: 'ภาษีที่หัก (บาท)', width: 80, align: 'right' as const },
    ];
    const drawHead = () => {
      doc.font('TH-Bold').fontSize(9);
      let x = doc.page.margins.left;
      const y = doc.y;
      for (const c of cols) {
        doc.text(c.label, x, y, { width: c.width, align: c.align ?? 'left' });
        x += c.width;
      }
      doc.moveDown(0.2);
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.2);
    };
    drawHead();

    doc.font('TH').fontSize(9);
    for (const [cat, g] of grouped.entries()) {
      const cells = [
        paidDate,
        `${labelFor(cat)} — ${g.descriptions.join(', ')}`,
        (g.netCents / 100).toLocaleString('th-TH', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        (g.rateBp / 100).toFixed(2),
        (g.whtCents / 100).toLocaleString('th-TH', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      ];
      let x = doc.page.margins.left;
      const y = doc.y;
      for (let i = 0; i < cols.length; i++) {
        doc.text(cells[i], x, y, {
          width: cols[i].width,
          align: cols[i].align ?? 'left',
        });
        x += cols[i].width;
      }
      doc.moveDown(0.5);
    }
    // Totals row
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.2);
    doc.font('TH-Bold').fontSize(9);
    let x = doc.page.margins.left;
    const yt = doc.y;
    doc.text('รวม', x, yt, { width: cols[0].width });
    x += cols[0].width;
    doc.text('', x, yt, { width: cols[1].width });
    x += cols[1].width;
    doc.text(
      (totalNet / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 }),
      x,
      yt,
      { width: cols[2].width, align: 'right' },
    );
    x += cols[2].width;
    doc.text('', x, yt, { width: cols[3].width });
    x += cols[3].width;
    doc.text(
      (totalWht / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 }),
      x,
      yt,
      { width: cols[4].width, align: 'right' },
    );
    doc.moveDown(0.6);
    // Reset cursor to the left margin — the explicit-(x,y) text() calls above
    // leave doc.x stuck at the last column's x. Without this reset, subsequent
    // un-positioned text() calls render relative to that x and end up
    // squashed against the right edge of the page.
    doc.x = doc.page.margins.left;

    // ── Amount in Thai words ──────────────────────────────────────────────
    doc.font('TH').fontSize(9).text(
      `(${bahtTextFromSatang(totalWht)})`,
      { align: 'center' },
    );
    doc.moveDown(0.6);
    doc.x = doc.page.margins.left;

    // ── Submission type (mandatory boxes) ────────────────────────────────
    doc.font('TH-Bold').fontSize(9).text('ประเภทการยื่น:');
    doc.font('TH').fontSize(9);
    this.tickboxRow(doc, [
      // PAY_CON 1 — standard "withhold from payee" path; only this case is
      // implemented in the bill flow today. When PAY_CON 2/3 (payer absorbs)
      // ships through the cert renderer, swap the `checked` flags here based
      // on the bill line's wht_payer_mode.
      { label: '(1) หัก ณ ที่จ่าย', checked: true },
      { label: '(2) ออกให้ตลอดไป', checked: false },
      { label: '(3) ออกให้ครั้งเดียว', checked: false },
    ]);
    doc.moveDown(1);

    // ── Signature area ───────────────────────────────────────────────────
    doc.font('TH').fontSize(9);
    doc.text('ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ');
    doc.moveDown(2);
    const sigY = doc.y;
    const half = (doc.page.width - 72) / 2;
    doc.text('ลายมือชื่อ ...........................................', 36, sigY, {
      width: half,
      align: 'center',
    });
    doc.text(
      'ตราประทับ (ถ้ามี) ...................................',
      36 + half,
      sigY,
      { width: half, align: 'center' },
    );
    doc.moveDown(1);
    doc.text('ผู้มีหน้าที่หักภาษี ณ ที่จ่าย', 36, doc.y, {
      width: half,
      align: 'center',
    });
    doc.text(`วันที่ ${paidDate}`, 36 + half, doc.y, {
      width: half,
      align: 'center',
    });

    // ── Retention notice ─────────────────────────────────────────────────
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    doc.moveDown(2);
    doc.x = doc.page.margins.left;
    doc
      .font('TH')
      .fontSize(7)
      .fillColor('#666')
      .text(
        'หนังสือรับรองนี้ออกโดยระบบ ERP-POS  •  ผู้ถูกหักภาษีโปรดเก็บไว้ใช้ประกอบการยื่นภาษี',
        { align: 'center' },
      );

    doc.end();
    return await done;
  }

  private box(
    doc: any,
    title: string,
    rows: Array<[string, string]>,
  ) {
    doc.font('TH-Bold').fontSize(10).text(title);
    doc.font('TH').fontSize(9);
    for (const [k, v] of rows) {
      doc.text(`   ${k}:  ${v}`);
    }
    doc.moveDown(0.4);
  }

  /**
   * Draw a single tickbox + label on its own line.
   *
   * The Unicode ballot-box chars (U+2610 / U+2611) aren't in Sarabun's glyph
   * table — they render as tiny indistinguishable squares. We draw the box as
   * a vector rect + an X-mark when checked. This is also how RD's official
   * frm_WTC.pdf does it.
   */
  private tickboxLine(doc: any, label: string, checked: boolean) {
    const SIZE = 9;
    const INDENT = 6;
    const GAP = 5;
    const x = doc.page.margins.left + INDENT;
    const y = doc.y;
    // Box top sits ~2pt below the text baseline to visually centre on a 9pt cap.
    const boxY = y + 2;
    doc.lineWidth(0.6).rect(x, boxY, SIZE, SIZE).stroke();
    if (checked) {
      doc.lineWidth(1.1);
      const inset = 1.6;
      doc
        .moveTo(x + inset, boxY + inset)
        .lineTo(x + SIZE - inset, boxY + SIZE - inset)
        .stroke();
      doc
        .moveTo(x + SIZE - inset, boxY + inset)
        .lineTo(x + inset, boxY + SIZE - inset)
        .stroke();
      doc.lineWidth(0.6);
    }
    // Write label after the box on the same baseline.
    const labelX = x + SIZE + GAP;
    const labelW = doc.page.width - doc.page.margins.right - labelX;
    doc.text(label, labelX, y, { width: labelW });
    // pdfkit leaves doc.x at the explicit x we passed (labelX) — reset to the
    // page left margin so subsequent un-positioned text() calls don't squash
    // against the right edge.
    doc.x = doc.page.margins.left;
  }

  /**
   * Draw multiple tickboxes inline on a single row (e.g. "ประเภทการยื่น"
   * triple-option). Each item has its own square + label; items are spaced
   * evenly across the available width so labels don't run into each other.
   */
  private tickboxRow(
    doc: any,
    items: Array<{ label: string; checked: boolean }>,
  ) {
    const SIZE = 9;
    const GAP = 4;       // gap between box and its label
    const SPACING = 14;  // gap between groups
    const startY = doc.y;
    const boxY = startY + 2;
    let cursor = doc.page.margins.left;
    for (const it of items) {
      doc.lineWidth(0.6).rect(cursor, boxY, SIZE, SIZE).stroke();
      if (it.checked) {
        doc.lineWidth(1.1);
        const inset = 1.6;
        doc
          .moveTo(cursor + inset, boxY + inset)
          .lineTo(cursor + SIZE - inset, boxY + SIZE - inset)
          .stroke();
        doc
          .moveTo(cursor + SIZE - inset, boxY + inset)
          .lineTo(cursor + inset, boxY + SIZE - inset)
          .stroke();
        doc.lineWidth(0.6);
      }
      const labelX = cursor + SIZE + GAP;
      const w = doc.widthOfString(it.label);
      doc.text(it.label, labelX, startY, { lineBreak: false });
      cursor = labelX + w + SPACING;
    }
    // doc.text with lineBreak:false leaves doc.y on the same line; bump down
    // to clear room for the next paragraph and reset x to the left margin.
    doc.y = startY + 14;
    doc.x = doc.page.margins.left;
  }

  private resolveFontDir(): string {
    const prod = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
    if (fs.existsSync(prod)) return prod;
    const dev = path.join(__dirname, '..', '..', '..', '..', 'src', 'assets', 'fonts');
    if (fs.existsSync(dev)) return dev;
    this.logger.warn(
      `Sarabun font directory not found at ${prod} or ${dev} — Thai chars will fall back to default`,
    );
    return prod;
  }
}

function labelFor(cat: string): string {
  switch (cat) {
    case 'services':
      return 'ค่าบริการ / ค่าจ้างทำของ (3%)';
    case 'rent':
      return 'ค่าเช่า (5%)';
    case 'ads':
      return 'ค่าโฆษณา (2%)';
    case 'freight':
      return 'ค่าขนส่ง (1%)';
    case 'dividends':
      return 'เงินปันผล (10%)';
    case 'interest':
      return 'ดอกเบี้ย (15%)';
    case 'foreign':
      return 'จ่ายให้ผู้รับต่างประเทศ (15%)';
    default:
      return cat;
  }
}
