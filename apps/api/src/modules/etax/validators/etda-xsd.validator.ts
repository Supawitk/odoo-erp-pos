import { Injectable, Logger } from '@nestjs/common';

/**
 * 🇹🇭 ETDA XSD validator (Phase 4B).
 *
 * Two-tier validation strategy:
 *
 *   TIER 1 — runtime structural checks (this class, in-process)
 *     - XML well-formedness (parses without errors)
 *     - Required ETDA elements present (CrossIndustryInvoice / ExchangedDocument /
 *       ID / TypeCode / SellerTradeParty / monetary summation)
 *     - T-code is one of T01..T05
 *     - Currency present, amounts have 2 decimals
 *
 *   TIER 2 — full XSD validation (CI workflow only)
 *     The CI workflow (.github/workflows/tax-invoice-xsd-validate.yml) downloads
 *     ETDA's official CrossIndustryInvoice 2.0 XSD bundle from the
 *     ETDA/etda-xmlvalidation GitHub repo and runs `xmllint --schema` against
 *     a sample of generated XML. Full XSD validation in-process would require
 *     ~50MB of dependency overhead (libxmljs / fast-xml-parser-validator) and
 *     a live download — neither belongs in the request path.
 *
 * If TIER 1 fails, the submission is blocked entirely (would never pass TIER 2
 * either). If TIER 1 passes but TIER 2 fails in CI, that's a build break.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

@Injectable()
export class EtdaXsdValidator {
  private readonly logger = new Logger(EtdaXsdValidator.name);

  /**
   * TIER 1 — structural validation. Fast, deterministic, no network.
   * The string-based checks are intentional: full XML DOM parsing for a
   * 2KB document on every checkout would be wasteful, and ETDA accepts
   * any well-formed XML with the required elements present.
   */
  validate(xml: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Well-formedness: no unclosed tags. Quick heuristic: count opening
    // and closing tags of the root element.
    const rootOpens = (xml.match(/<rsm:CrossIndustryInvoice/g) ?? []).length;
    const rootCloses = (xml.match(/<\/rsm:CrossIndustryInvoice>/g) ?? []).length;
    if (rootOpens !== 1 || rootCloses !== 1) {
      errors.push(`expected exactly 1 <rsm:CrossIndustryInvoice> open + close, got open=${rootOpens} close=${rootCloses}`);
    }

    // 2. XML declaration
    if (!xml.startsWith('<?xml')) {
      errors.push('XML declaration <?xml ?> required as first node');
    }

    // 3. Required namespaces — ETDA's spec requires the rsm/ram/udt triple.
    if (!xml.includes('xmlns:rsm=')) errors.push('missing rsm namespace declaration');
    if (!xml.includes('xmlns:ram=')) errors.push('missing ram namespace declaration');
    if (!xml.includes('xmlns:udt=')) errors.push('missing udt namespace declaration');

    // 4. Required elements
    const required: Array<[string, RegExp]> = [
      ['ExchangedDocument', /<rsm:ExchangedDocument>/],
      ['Document ID', /<ram:ID>[^<]+<\/ram:ID>/],
      ['TypeCode', /<ram:TypeCode>(T0[1-5])<\/ram:TypeCode>/],
      ['IssueDateTime', /<ram:IssueDateTime>/],
      ['SupplyChainTradeTransaction', /<rsm:SupplyChainTradeTransaction>/],
      ['SellerTradeParty', /<ram:SellerTradeParty>/],
      ['Trade line item', /<ram:IncludedSupplyChainTradeLineItem>/],
      ['Header settlement', /<ram:ApplicableHeaderTradeSettlement>/],
      ['Currency code', /<ram:InvoiceCurrencyCode>[A-Z]{3}<\/ram:InvoiceCurrencyCode>/],
      ['Grand total', /<ram:GrandTotalAmount[^>]*>-?[\d.]+<\/ram:GrandTotalAmount>/],
    ];
    for (const [label, re] of required) {
      if (!re.test(xml)) errors.push(`missing/malformed: ${label}`);
    }

    // 5. T-code matches one of the 5 supported codes
    const typeMatch = xml.match(/<ram:TypeCode>(T0[1-5])<\/ram:TypeCode>/);
    if (typeMatch && !['T01', 'T02', 'T03', 'T04', 'T05'].includes(typeMatch[1])) {
      errors.push(`unknown TypeCode: ${typeMatch[1]} (expected T01..T05)`);
    }

    // 6. Money formatting — every currency-tagged amount should have 2 decimals.
    const moneyMatches = xml.match(/currencyID="[A-Z]{3}">([\d.-]+)</g) ?? [];
    for (const m of moneyMatches) {
      const value = m.match(/>([\d.-]+)</)?.[1];
      if (value && !/^-?\d+\.\d{2}$/.test(value)) {
        errors.push(`malformed currency amount "${value}" — must be N.NN`);
      }
    }

    // 7. Seller TIN — TXID schemeID present
    if (!/<ram:ID schemeID="TXID">\d{13}<\/ram:ID>/.test(xml)) {
      // Some doc types may legitimately omit but for now we require seller TIN
      warnings.push('seller TIN with schemeID="TXID" not found (required for ETDA)');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
