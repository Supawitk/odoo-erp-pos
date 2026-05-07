import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  type TaxInvoiceDto,
  type PartyInfo,
  type InvoiceLineDto,
  type EtdaDocumentCode,
  etdaCodeFor,
} from '../dtos/tax-invoice.dto';

/**
 * 🇹🇭 Tax invoice → ETDA CrossIndustryInvoice 2.0 XML builder.
 *
 * Structure follows ขมธอ.3-2560 (ETDA e-Tax invoice schema, derived from UN/CEFACT
 * CrossIndustryInvoice 2.0):
 *
 *   <rsm:CrossIndustryInvoice>
 *     <rsm:ExchangedDocumentContext>...</rsm:ExchangedDocumentContext>
 *     <rsm:ExchangedDocument>
 *       <ram:ID>TX2604-000042</ram:ID>
 *       <ram:TypeCode>T01</ram:TypeCode>
 *       <ram:IssueDateTime>...</ram:IssueDateTime>
 *     </rsm:ExchangedDocument>
 *     <rsm:SupplyChainTradeTransaction>
 *       <ram:IncludedSupplyChainTradeLineItem>...</ram:IncludedSupplyChainTradeLineItem>
 *       <ram:ApplicableHeaderTradeAgreement>
 *         <ram:SellerTradeParty>...</ram:SellerTradeParty>
 *         <ram:BuyerTradeParty>...</ram:BuyerTradeParty>
 *       </ram:ApplicableHeaderTradeAgreement>
 *       <ram:ApplicableHeaderTradeSettlement>
 *         <ram:ApplicableTradeTax>...</ram:ApplicableTradeTax>
 *         <ram:SpecifiedTradeSettlementHeaderMonetarySummation>...</ram:SpecifiedTradeSettlementHeaderMonetarySummation>
 *       </ram:ApplicableHeaderTradeSettlement>
 *     </rsm:SupplyChainTradeTransaction>
 *   </rsm:CrossIndustryInvoice>
 *
 * Money is rendered as decimal THB (2 decimal places) since ETDA's XSD uses
 * xs:decimal — we divide satang by 100 once at render boundaries. All values
 * are stable strings so a re-render of the same dto produces an identical XML
 * (sha256 hash is reproducible — important for tamper detection).
 */
@Injectable()
export class TaxInvoiceXmlBuilder {
  /**
   * Build XML from the DTO.
   * Returns both the rendered XML and its sha256 hex hash so the caller can
   * persist both in `etax_submissions.xml_payload` + `xml_hash`.
   */
  build(dto: TaxInvoiceDto): { xml: string; hash: string; etdaCode: EtdaDocumentCode } {
    this.validate(dto);
    const xml = this.renderInvoice(dto);
    const hash = createHash('sha256').update(xml, 'utf8').digest('hex');
    return { xml, hash, etdaCode: etdaCodeFor(dto.documentType) };
  }

  /** Defence-in-depth shape check. The DB constraints are the real gate. */
  private validate(dto: TaxInvoiceDto): void {
    if (!dto.seller.tin) throw new Error('seller TIN required for e-Tax invoice');
    if (!/^\d{13}$/.test(dto.seller.tin)) {
      throw new Error(`seller TIN must be 13 digits, got ${dto.seller.tin}`);
    }
    if (!dto.documentNumber) throw new Error('documentNumber required');
    if (dto.lines.length === 0) throw new Error('cannot build XML with no lines');
    if (dto.documentType === 'TX' && !dto.buyer?.tin) {
      throw new Error('TX (full tax invoice) requires buyer TIN');
    }
    if ((dto.documentType === 'CN' || dto.documentType === 'DN') && !dto.originalDocument) {
      throw new Error('CN/DN requires originalDocument reference');
    }
    // Arithmetic sanity — caller is server-authoritative, but a wrong DTO would
    // mean RD ack on a math-broken invoice.
    const sumGross = dto.lines.reduce((s, l) => s + l.grossCents, 0);
    if (Math.abs(sumGross - dto.totals.grandTotalCents) > 1) {
      throw new Error(
        `line gross sum ${sumGross} ≠ grandTotalCents ${dto.totals.grandTotalCents} (drift > 1 satang)`,
      );
    }
  }

  private renderInvoice(dto: TaxInvoiceDto): string {
    const code = etdaCodeFor(dto.documentType);
    const issueIso = dto.issueDate.toISOString().slice(0, 19);
    const lineXml = dto.lines.map((l) => this.renderLine(l, dto.currency)).join('\n');
    const sellerXml = this.renderParty(dto.seller, 'Seller');
    const buyerXml = dto.buyer ? this.renderParty(dto.buyer, 'Buyer') : '';
    const refXml = dto.originalDocument
      ? `        <ram:InvoiceReferencedDocument>
          <ram:IssuerAssignedID>${escapeXml(dto.originalDocument.documentNumber)}</ram:IssuerAssignedID>
          <ram:FormattedIssueDateTime>
            <udt:DateTimeString format="102">${formatIssueDate(dto.originalDocument.issueDate)}</udt:DateTimeString>
          </ram:FormattedIssueDateTime>
        </ram:InvoiceReferencedDocument>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
    xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
    xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
    xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:etda:thailand:etax:cii:2.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${escapeXml(dto.documentNumber)}</ram:ID>
    <ram:TypeCode>${code}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${formatIssueDate(dto.issueDate)}</udt:DateTimeString>
    </ram:IssueDateTime>${dto.reason ? `
    <ram:IncludedNote>
      <ram:Content>${escapeXml(dto.reason)}</ram:Content>
    </ram:IncludedNote>` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${lineXml}
    <ram:ApplicableHeaderTradeAgreement>
${sellerXml}
${buyerXml}
${refXml}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">${formatIssueDate(dto.issueDate)}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${escapeXml(dto.currency)}</ram:InvoiceCurrencyCode>
${this.renderTaxBreakdown(dto)}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.subtotalCents)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.taxableNetCents + dto.totals.zeroRatedNetCents + dto.totals.exemptNetCents)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.vatCents)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.grandTotalCents)}</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
  }

  private renderLine(line: InvoiceLineDto, currency: string): string {
    const taxCategory = vatCategoryToCode(line.vatCategory);
    const taxRate = line.vatCategory === 'standard' ? '7.00' : '0.00';
    return `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${line.lineNo}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escapeXml(line.name)}</ram:Name>${line.sku ? `
        <ram:SellerAssignedID>${escapeXml(line.sku)}</ram:SellerAssignedID>` : ''}
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount currencyID="${escapeXml(currency)}">${money(line.unitPriceCents)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="EA">${line.qty}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${taxCategory}</ram:CategoryCode>
          <ram:RateApplicablePercent>${taxRate}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount currencyID="${escapeXml(currency)}">${money(line.netCents)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }

  private renderParty(p: PartyInfo, role: 'Seller' | 'Buyer'): string {
    return `      <ram:${role}TradeParty>
        <ram:Name>${escapeXml(p.name)}</ram:Name>${p.tin ? `
        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="TXID">${escapeXml(p.tin)}</ram:ID>${p.branch ? `
          <ram:PostalTradeAddress>
            <ram:LineOne>Branch ${escapeXml(p.branch)}</ram:LineOne>
            <ram:CountryID>${escapeXml(p.countryCode ?? 'TH')}</ram:CountryID>
          </ram:PostalTradeAddress>` : ''}
        </ram:SpecifiedLegalOrganization>` : ''}${p.address ? `
        <ram:PostalTradeAddress>
          <ram:LineOne>${escapeXml(p.address)}</ram:LineOne>${p.countrySubdivision ? `
          <ram:CountrySubDivisionName>${escapeXml(p.countrySubdivision)}</ram:CountrySubDivisionName>` : ''}
          <ram:CountryID>${escapeXml(p.countryCode ?? 'TH')}</ram:CountryID>
        </ram:PostalTradeAddress>` : ''}${p.email ? `
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${escapeXml(p.email)}</ram:URIID>
        </ram:URIUniversalCommunication>` : ''}
      </ram:${role}TradeParty>`;
  }

  private renderTaxBreakdown(dto: TaxInvoiceDto): string {
    const blocks: string[] = [];
    if (dto.totals.taxableNetCents > 0) {
      blocks.push(`      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.vatCents)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.taxableNetCents)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`);
    }
    if (dto.totals.zeroRatedNetCents > 0) {
      blocks.push(`      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount currencyID="${escapeXml(dto.currency)}">0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.zeroRatedNetCents)}</ram:BasisAmount>
        <ram:CategoryCode>Z</ram:CategoryCode>
        <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`);
    }
    if (dto.totals.exemptNetCents > 0) {
      blocks.push(`      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount currencyID="${escapeXml(dto.currency)}">0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount currencyID="${escapeXml(dto.currency)}">${money(dto.totals.exemptNetCents)}</ram:BasisAmount>
        <ram:CategoryCode>E</ram:CategoryCode>
        <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`);
    }
    return blocks.join('\n');
  }
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function money(cents: number): string {
  // ETDA uses xs:decimal; render fixed 2 decimals; sign-preserving for CN.
  return (cents / 100).toFixed(2);
}

function formatIssueDate(d: Date): string {
  // CCYYMMDD per UN/CEFACT format 102.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

function vatCategoryToCode(category: 'standard' | 'zero_rated' | 'exempt'): 'S' | 'Z' | 'E' {
  if (category === 'standard') return 'S';
  if (category === 'zero_rated') return 'Z';
  return 'E';
}
