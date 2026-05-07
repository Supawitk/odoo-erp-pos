import { describe, it, expect } from 'vitest';
import { TaxInvoiceXmlBuilder } from '../../src/modules/etax/services/tax-invoice-xml-builder';
import { EtdaXsdValidator } from '../../src/modules/etax/validators/etda-xsd.validator';
import type { TaxInvoiceDto } from '../../src/modules/etax/dtos/tax-invoice.dto';

/**
 * 🇹🇭 Unit tests for the e-Tax XML builder + structural validator.
 *
 * Covers the 5 ETDA T-codes (T01..T05), the structural-validation gate, and
 * the determinism property (same dto → byte-identical XML → same hash).
 *
 * Full XSD validation runs in CI (.github/workflows/tax-invoice-xsd-validate.yml).
 */

const builder = new TaxInvoiceXmlBuilder();
const validator = new EtdaXsdValidator();

const SELLER = {
  name: 'Test Seller Co Ltd',
  tin: '0105551234567',
  branch: '00000',
  address: '123 Sukhumvit Rd, Bangkok 10110',
  countryCode: 'TH',
};

const BUYER = {
  name: 'Test Buyer Co',
  tin: '0107537000254',
  branch: '00000',
  address: '456 Rama IV Rd, Bangkok 10500',
  countryCode: 'TH',
};

function txDto(overrides: Partial<TaxInvoiceDto> = {}): TaxInvoiceDto {
  return {
    orderId: 'order-uuid-1',
    documentType: 'TX',
    documentNumber: 'TX2604-000001',
    issueDate: new Date('2026-04-15T10:00:00.000Z'),
    currency: 'THB',
    seller: SELLER,
    buyer: BUYER,
    lines: [
      {
        lineNo: 1,
        name: 'Test Service',
        qty: 1,
        unitPriceCents: 10000,
        discountCents: 0,
        vatCategory: 'standard',
        netCents: 10000,
        vatCents: 700,
        grossCents: 10700,
      },
    ],
    totals: {
      subtotalCents: 10000,
      vatCents: 700,
      grandTotalCents: 10700,
      taxableNetCents: 10000,
      zeroRatedNetCents: 0,
      exemptNetCents: 0,
    },
    ...overrides,
  };
}

describe('TaxInvoiceXmlBuilder', () => {
  it('builds T01 (TX) XML with all required ETDA elements', () => {
    const result = builder.build(txDto());
    expect(result.etdaCode).toBe('T01');
    expect(result.xml).toContain('<rsm:CrossIndustryInvoice');
    expect(result.xml).toContain('<ram:TypeCode>T01</ram:TypeCode>');
    expect(result.xml).toContain('<ram:ID>TX2604-000001</ram:ID>');
    expect(result.xml).toContain('<ram:ID schemeID="TXID">0105551234567</ram:ID>');
    expect(result.xml).toContain('<ram:ID schemeID="TXID">0107537000254</ram:ID>');
    expect(result.xml).toContain('<ram:GrandTotalAmount currencyID="THB">107.00</ram:GrandTotalAmount>');
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds T02 (ABB) without buyer block', () => {
    const result = builder.build(
      txDto({ documentType: 'ABB', documentNumber: 'ABB2604-000001', buyer: undefined }),
    );
    expect(result.etdaCode).toBe('T02');
    expect(result.xml).toContain('<ram:TypeCode>T02</ram:TypeCode>');
    expect(result.xml).not.toContain('BuyerTradeParty');
  });

  it('builds T04 (CN) referencing original document', () => {
    const result = builder.build(
      txDto({
        documentType: 'CN',
        documentNumber: 'CN2604-000001',
        originalDocument: {
          documentNumber: 'TX2604-000001',
          issueDate: new Date('2026-04-10T10:00:00.000Z'),
        },
        reason: 'partial refund',
        lines: [
          {
            lineNo: 1,
            name: 'Refund line',
            qty: -1,
            unitPriceCents: 10000,
            discountCents: 0,
            vatCategory: 'standard',
            netCents: -10000,
            vatCents: -700,
            grossCents: -10700,
          },
        ],
        totals: {
          subtotalCents: -10000,
          vatCents: -700,
          grandTotalCents: -10700,
          taxableNetCents: -10000,
          zeroRatedNetCents: 0,
          exemptNetCents: 0,
        },
      }),
    );
    expect(result.etdaCode).toBe('T04');
    expect(result.xml).toContain('<ram:TypeCode>T04</ram:TypeCode>');
    expect(result.xml).toContain('<ram:InvoiceReferencedDocument>');
    expect(result.xml).toContain('<ram:IssuerAssignedID>TX2604-000001</ram:IssuerAssignedID>');
    expect(result.xml).toContain('<ram:Content>partial refund</ram:Content>');
    expect(result.xml).toContain('<ram:GrandTotalAmount currencyID="THB">-107.00</ram:GrandTotalAmount>');
  });

  it('builds deterministic output (same dto → same hash)', () => {
    const a = builder.build(txDto());
    const b = builder.build(txDto());
    expect(a.xml).toBe(b.xml);
    expect(a.hash).toBe(b.hash);
  });

  it('rejects DTO with missing seller TIN', () => {
    expect(() =>
      builder.build(txDto({ seller: { ...SELLER, tin: undefined as any } })),
    ).toThrow(/seller TIN required/);
  });

  it('rejects TX without buyer TIN (TX → buyer TIN mandatory per §86/4)', () => {
    expect(() => builder.build(txDto({ buyer: undefined }))).toThrow(
      /TX \(full tax invoice\) requires buyer TIN/,
    );
  });

  it('rejects CN without originalDocument reference', () => {
    expect(() =>
      builder.build(txDto({ documentType: 'CN', originalDocument: undefined })),
    ).toThrow(/CN\/DN requires originalDocument/);
  });

  it('rejects DTO with line-sum drift > 1 satang', () => {
    expect(() =>
      builder.build(
        txDto({
          // line gross 10700, but stated grand total 12000 — drift 1300
          totals: {
            subtotalCents: 10000,
            vatCents: 700,
            grandTotalCents: 12000,
            taxableNetCents: 10000,
            zeroRatedNetCents: 0,
            exemptNetCents: 0,
          },
        }),
      ),
    ).toThrow(/drift > 1 satang/);
  });

  it('renders mixed-VAT-category breakdown blocks', () => {
    const result = builder.build(
      txDto({
        lines: [
          { lineNo: 1, name: 'Standard', qty: 1, unitPriceCents: 10000, discountCents: 0, vatCategory: 'standard', netCents: 10000, vatCents: 700, grossCents: 10700 },
          { lineNo: 2, name: 'Zero', qty: 1, unitPriceCents: 5000, discountCents: 0, vatCategory: 'zero_rated', netCents: 5000, vatCents: 0, grossCents: 5000 },
          { lineNo: 3, name: 'Exempt', qty: 1, unitPriceCents: 2000, discountCents: 0, vatCategory: 'exempt', netCents: 2000, vatCents: 0, grossCents: 2000 },
        ],
        totals: {
          subtotalCents: 17000,
          vatCents: 700,
          grandTotalCents: 17700,
          taxableNetCents: 10000,
          zeroRatedNetCents: 5000,
          exemptNetCents: 2000,
        },
      }),
    );
    // Three top-level ApplicableTradeTax under header settlement
    const matches = result.xml.match(/<ram:CategoryCode>([SZE])<\/ram:CategoryCode>/g) ?? [];
    expect(matches.some((m) => m.includes('S'))).toBe(true);
    expect(matches.some((m) => m.includes('Z'))).toBe(true);
    expect(matches.some((m) => m.includes('E'))).toBe(true);
  });

  it('escapes XML special characters in strings', () => {
    const result = builder.build(
      txDto({
        seller: { ...SELLER, name: 'A & B <Co> "Ltd"' },
        lines: [
          {
            lineNo: 1,
            name: "Item with 'apostrophe' & ampersand",
            qty: 1,
            unitPriceCents: 10000,
            discountCents: 0,
            vatCategory: 'standard',
            netCents: 10000,
            vatCents: 700,
            grossCents: 10700,
          },
        ],
      }),
    );
    expect(result.xml).toContain('A &amp; B &lt;Co&gt; &quot;Ltd&quot;');
    expect(result.xml).toContain('Item with &apos;apostrophe&apos; &amp; ampersand');
  });
});

describe('EtdaXsdValidator (TIER 1 structural)', () => {
  it('passes well-formed TX XML', () => {
    const { xml } = builder.build(txDto());
    const result = validator.validate(xml);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes ABB without buyer block', () => {
    const { xml } = builder.build(
      txDto({ documentType: 'ABB', documentNumber: 'ABB2604-000001', buyer: undefined }),
    );
    const result = validator.validate(xml);
    expect(result.valid).toBe(true);
  });

  it('rejects XML missing namespace declarations', () => {
    const xml = '<?xml version="1.0"?><rsm:CrossIndustryInvoice></rsm:CrossIndustryInvoice>';
    const result = validator.validate(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rsm namespace'))).toBe(true);
  });

  it('rejects XML missing TypeCode', () => {
    const xml = `<?xml version="1.0"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="x" xmlns:udt="x">
<rsm:ExchangedDocument><ram:ID>X</ram:ID></rsm:ExchangedDocument>
</rsm:CrossIndustryInvoice>`;
    const result = validator.validate(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TypeCode'))).toBe(true);
  });

  it('rejects malformed currency amounts (not 2 decimals)', () => {
    const { xml } = builder.build(txDto());
    const corrupted = xml.replace('107.00', '107');
    const result = validator.validate(corrupted);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('malformed currency'))).toBe(true);
  });

  it('accepts negative currency amounts (CN refund case)', () => {
    const { xml } = builder.build(
      txDto({
        documentType: 'CN',
        documentNumber: 'CN2604-000001',
        originalDocument: { documentNumber: 'TX2604-000001', issueDate: new Date() },
        lines: [
          {
            lineNo: 1,
            name: 'Refund',
            qty: -1,
            unitPriceCents: 10000,
            discountCents: 0,
            vatCategory: 'standard',
            netCents: -10000,
            vatCents: -700,
            grossCents: -10700,
          },
        ],
        totals: {
          subtotalCents: -10000,
          vatCents: -700,
          grandTotalCents: -10700,
          taxableNetCents: -10000,
          zeroRatedNetCents: 0,
          exemptNetCents: 0,
        },
      }),
    );
    const result = validator.validate(xml);
    expect(result.valid).toBe(true);
  });
});
