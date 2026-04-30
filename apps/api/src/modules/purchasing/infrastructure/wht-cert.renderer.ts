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
        `เลขที่อ้างอิง / Reference: ${bill.internalNumber}    ออกเมื่อ / Issued: ${paidDate}`,
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
    const tickbox = (label: string, checked: boolean) =>
      `${checked ? '☑' : '☐'} ${label}`;
    doc.text(tickbox('1. เงินเดือน ค่าจ้าง (มาตรา 40(1))', false));
    doc.text(
      tickbox(
        '2. ค่าธรรมเนียม ค่านายหน้า ค่าโฆษณา (มาตรา 40(2))',
        isCategory('services') || isCategory('ads'),
      ),
    );
    doc.text(tickbox('3. ค่าแห่งลิขสิทธิ์ กู๊ดวิลล์ (มาตรา 40(3))', false));
    doc.text(
      tickbox(
        '4(ก). ดอกเบี้ย (มาตรา 40(4)(ก))',
        isCategory('interest'),
      ),
    );
    doc.text(
      tickbox(
        '4(ข). เงินปันผล (มาตรา 40(4)(ข))',
        isCategory('dividends'),
      ),
    );
    doc.text(
      tickbox(
        '5. การจ่ายให้ผู้รับในต่างประเทศ (มาตรา 70)',
        isCategory('foreign'),
      ),
    );
    doc.text(
      tickbox(
        '6. ค่าเช่าทรัพย์สิน (มาตรา 40(5))',
        isCategory('rent'),
      ),
    );
    doc.text(
      tickbox(
        '7. อื่นๆ — ค่าจ้างทำของ ค่าบริการ ค่าขนส่ง',
        isCategory('services') || isCategory('freight'),
      ),
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

    // ── Amount in Thai words ──────────────────────────────────────────────
    doc.font('TH').fontSize(9).text(
      `(${bahtTextFromSatang(totalWht)})`,
      { align: 'center' },
    );
    doc.moveDown(0.6);

    // ── Submission type (mandatory boxes) ────────────────────────────────
    doc.font('TH-Bold').fontSize(9).text('ประเภทการยื่น:');
    doc.font('TH').fontSize(9);
    doc.text('☑ (1) หัก ณ ที่จ่าย    ☐ (2) ออกให้ตลอดไป    ☐ (3) ออกให้ครั้งเดียว');
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
