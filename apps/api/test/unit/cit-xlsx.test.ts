import { describe, it, expect } from 'vitest';
import * as JSZip from 'jszip';
import { buildCitXlsx } from '../../src/modules/reports/cit-xlsx.builder';
import type { CitPreviewResult } from '../../src/modules/reports/cit.service';

/**
 * Pure-builder tests for the PND.50 / PND.51 XLSX generator.
 *
 * The CitService preview is exercised in integration tests; here we just want
 * to confirm the builder produces a valid xlsx with the expected sheets +
 * Thai-labeled boxes for both forms.
 */

const SENDER = {
  payerTin: '0105551234567',
  payerBranch: '00000',
  payerName: 'บริษัท ตัวอย่าง จำกัด',
};

function basePreview(): CitPreviewResult {
  return {
    fiscalYear: 2026,
    halfYear: false,
    periodFrom: '2026-01-01',
    periodTo: '2026-12-31',
    revenueCents: 100_000_000, // ฿1M
    expenseCents: 60_000_000,  // ฿600k
    nonDeductibleCents: 0,
    nonDeductibleByCategory: {
      entertainment_over_cap: 0,
      personal: 0,
      capital_expensed: 0,
      donations_over_cap: 0,
      fines_penalties: 0,
      cit_self: 0,
      reserves_provisions: 0,
      non_business: 0,
      excessive_depreciation: 0,
      undocumented: 0,
      foreign_overhead: 0,
      other: 0,
    },
    deductibleExpenseCents: 60_000_000,
    accountingNetIncomeCents: 40_000_000,
    taxableIncomeCents: 40_000_000,
    paidInCapitalCents: 100_000_000,
    annualisedRevenueCents: 100_000_000,
    taxDueCents: 8_000_000, // 20% on ฿400k
    rateBracket: 'flat20',
    breakdown: [
      { label: '20% × ฿400,000', baseCents: 40_000_000, rate: 0.2, taxCents: 8_000_000 },
    ],
    whtCreditsCents: 0,
    advancePaidCents: 0,
    netPayableCents: 8_000_000,
    alreadyFiled: false,
    filing: null,
    warnings: [],
  };
}

async function readSheetNames(buffer: Buffer): Promise<string[]> {
  const zip = await (JSZip as any).loadAsync(buffer);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  return Array.from(wbXml.matchAll(/<sheet[^>]*name="([^"]+)"/g), (m: any) => m[1]);
}

async function readSharedStrings(buffer: Buffer): Promise<string[]> {
  const zip = await (JSZip as any).loadAsync(buffer);
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return [];
  const xml = await file.async('string');
  // Extract <t> and <t xml:space="preserve">…</t>
  return Array.from(xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g), (m: any) =>
    decodeXml(m[1]),
  );
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

describe('PND.50 / PND.51 XLSX builder', () => {
  it('PND.50 produces 5 sheets with the expected Thai names', async () => {
    const { filename, buffer } = await buildCitXlsx(basePreview(), SENDER);
    expect(filename).toBe('PND50_2026_0105551234567_000000.xlsx');
    expect(buffer.length).toBeGreaterThan(4000);

    const sheets = await readSheetNames(buffer);
    expect(sheets).toEqual([
      'สรุป (ภ.ง.ด.50)',
      'กระทบยอดกำไรสุทธิ',
      'รายละเอียด §65 ตรี',
      'ภาษีคำนวณ (Brackets)',
      'เครดิตภาษี (Credits)',
    ]);
  });

  it('PND.51 produces 4 sheets (no Credits sheet)', async () => {
    const half: CitPreviewResult = {
      ...basePreview(),
      halfYear: true,
      periodTo: '2026-06-30',
      revenueCents: 50_000_000,
      annualisedRevenueCents: 100_000_000,
      taxDueCents: 4_000_000, // half of full-year
    };
    const { filename, buffer } = await buildCitXlsx(half, SENDER);
    expect(filename).toBe('PND51_2026_0105551234567_000000.xlsx');

    const sheets = await readSheetNames(buffer);
    expect(sheets).toEqual([
      'สรุป (ภ.ง.ด.51)',
      'กระทบยอดกำไรสุทธิ',
      'รายละเอียด §65 ตรี',
      'ภาษีคำนวณ (Brackets)',
    ]);
  });

  it('summary contains correct Thai labels and TIN format', async () => {
    const { buffer } = await buildCitXlsx(basePreview(), SENDER);
    const strings = await readSharedStrings(buffer);

    // RD-format TIN with hyphens (X-XXXX-XXXXX-XX-X)
    expect(strings).toContain('0-1055-51234-56-7');

    // Mandatory section headers
    expect(strings).toContain('PND.50 — ภ.ง.ด.50');
    expect(strings).toContain('การปรับปรุงตามมาตรา 65 ตรี / §65 ter adjustments');
    expect(strings).toContain('การคำนวณภาษี / Tax calculation');

    // Buddhist-Era year (2026 + 543 = 2569)
    expect(strings).toContain('2569 (พ.ศ.)');

    // Half-year wording must NOT appear on PND.50
    expect(strings).not.toContain('ครึ่งปี / half-year estimate');
  });

  it('PND.51 summary uses half-year-specific wording', async () => {
    const half: CitPreviewResult = {
      ...basePreview(),
      halfYear: true,
      periodTo: '2026-06-30',
    };
    const { buffer } = await buildCitXlsx(half, SENDER);
    const strings = await readSharedStrings(buffer);

    // The half-year-only annualised-revenue label
    expect(strings).toContain('รายได้ประมาณการรายปี / Annualised revenue (H1×2)');
    // The half-year-only tax-computed suffix
    expect(strings.some((s) => s.includes('ครึ่งปี'))).toBe(true);
    // Fix for the typo we caught visually
    expect(strings.some((s) => s.includes('เครึ่งปี'))).toBe(false);
  });

  it('§65 ter sheet always lists every category, even when zero', async () => {
    const { buffer } = await buildCitXlsx(basePreview(), SENDER);
    const strings = await readSharedStrings(buffer);

    // Each TH category label should appear on the §65 ter sheet. Match against
    // the canonical labels in non-deductible.calculator.ts.
    const expectedCategories = [
      'ค่ารับรองเกินอัตรา',
      'รายจ่ายส่วนตัว',
      'รายจ่ายอันมีลักษณะเป็นการลงทุน',
      'เงินบริจาคเกินกำหนด',
      'เบี้ยปรับ/เงินเพิ่ม',
      'ภาษีเงินได้นิติบุคคล',
      'เงินสำรอง/ค่าเผื่อ',
    ];
    for (const c of expectedCategories) {
      expect(
        strings.some((s) => s.includes(c)),
        `expected to find "${c}" in shared strings`,
      ).toBe(true);
    }
  });

  it('warning rows render when CitPreview includes warnings', async () => {
    const withWarn: CitPreviewResult = {
      ...basePreview(),
      warnings: [
        'Paid-in capital ≤ ฿5M but revenue ≥ ฿30M — verify SME eligibility',
        'PND.51 advance not yet recorded — net may be wrong',
      ],
    };
    const { buffer } = await buildCitXlsx(withWarn, SENDER);
    const strings = await readSharedStrings(buffer);
    expect(strings).toContain('คำเตือน / Warnings');
    expect(strings.some((s) => s.includes('SME eligibility'))).toBe(true);
    expect(strings.some((s) => s.includes('PND.51 advance'))).toBe(true);
  });

  it('credits sheet flags refund-claimable when net is negative (PND.50 only)', async () => {
    const refund: CitPreviewResult = {
      ...basePreview(),
      whtCreditsCents: 12_000_000, // ฿120k WHT > ฿80k tax
      netPayableCents: -4_000_000,
    };
    const { buffer } = await buildCitXlsx(refund, SENDER);
    const strings = await readSharedStrings(buffer);
    expect(
      strings.some((s) => s.includes('ขอคืนภาษี') || s.includes('refund claimable')),
    ).toBe(true);
  });

  it('TIN with stray hyphens still produces a clean filename + display', async () => {
    const { filename, buffer } = await buildCitXlsx(basePreview(), {
      ...SENDER,
      payerTin: '0-1055-51234-56-7',
    });
    expect(filename).toBe('PND50_2026_0105551234567_000000.xlsx');
    const strings = await readSharedStrings(buffer);
    expect(strings).toContain('0-1055-51234-56-7');
  });
});
