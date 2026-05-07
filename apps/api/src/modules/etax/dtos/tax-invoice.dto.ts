/**
 * 🇹🇭 e-Tax invoice DTOs (Phase 4B).
 *
 * Shape mirrors ETDA's CrossIndustryInvoice 2.0 (ขมธอ.3-2560) document:
 *   - SellerInfo, BuyerInfo, Lines, Totals, Document metadata
 * Mapper consumes a `TaxInvoiceDto` and emits XML conforming to the official
 * ETDA XSD. The same DTO works for TX, ABB, RE, CN, DN — etdaCode is set in
 * the builder per documentType.
 */

export type EtdaDocumentCode =
  | 'T01' // ใบกำกับภาษี (TX)
  | 'T02' // ใบกำกับภาษีอย่างย่อ (ABB) — also used for RE in submissions per ETDA mapping
  | 'T03' // ใบเพิ่มหนี้ (DN)
  | 'T04' // ใบลดหนี้ (CN)
  | 'T05'; // ใบเสร็จรับเงิน (RE for VAT-registered sellers)

export interface PartyInfo {
  /** Legal/registered name (Thai canonical). */
  name: string;
  /** 13-digit TIN. Optional for buyer (walk-in retail). */
  tin?: string;
  /** 5-digit branch code; '00000' = HQ. */
  branch?: string;
  /** Full street address; required for seller, optional for buyer. */
  address?: string;
  /** ISO-3166-2 subdivision (e.g. "TH-10" Bangkok). Optional. */
  countrySubdivision?: string;
  /** "TH" — defaults applied at builder level. */
  countryCode?: string;
  /** Optional — only relevant for foreign buyers (export). */
  email?: string;
  phone?: string;
}

export interface InvoiceLineDto {
  /** Line number 1..N (1-indexed). */
  lineNo: number;
  /** Product display name. */
  name: string;
  /** Quantity sold. */
  qty: number;
  /** Unit price in satang (gross/net depends on vatMode). */
  unitPriceCents: number;
  /** Line-level discount in satang (already applied to grossCents). */
  discountCents: number;
  /** VAT category for this line. */
  vatCategory: 'standard' | 'zero_rated' | 'exempt';
  /** Net amount before VAT (qty × unitPrice − discount + excise). */
  netCents: number;
  /** VAT charged on this line. */
  vatCents: number;
  /** Gross = net + vat. */
  grossCents: number;
  /** SKU/EAN if available. */
  sku?: string;
}

export interface InvoiceTotalsDto {
  /** Sum of net (taxable+zero+exempt). */
  subtotalCents: number;
  /** Total VAT charged. */
  vatCents: number;
  /** Grand total = subtotal + vat. */
  grandTotalCents: number;
  /** Net of taxable (7%) lines only. */
  taxableNetCents: number;
  /** Net of zero-rated lines. */
  zeroRatedNetCents: number;
  /** Net of exempt lines. */
  exemptNetCents: number;
}

export interface TaxInvoiceDto {
  /** Internal POS order id (uuid) — used as our IssuerSpecifiedReferencedDocument id. */
  orderId: string;
  /** Document type → drives etdaCode. */
  documentType: 'RE' | 'ABB' | 'TX' | 'CN' | 'DN';
  /** Final allocated number, e.g. "TX2604-000042". */
  documentNumber: string;
  /** Issue date in Asia/Bangkok. */
  issueDate: Date;
  /** Currency, ISO-4217 — almost always THB. */
  currency: string;
  seller: PartyInfo;
  buyer?: PartyInfo;
  lines: InvoiceLineDto[];
  totals: InvoiceTotalsDto;
  /** For CN/DN: the original tax invoice this amends. */
  originalDocument?: {
    documentNumber: string;
    issueDate: Date;
  };
  /** Free-text reason for credit/debit notes. */
  reason?: string;
}

/**
 * Map our internal documentType to ETDA T-code.
 * RE for VAT-registered seller is treated as T05; non-VAT receipts don't go to ETDA at all.
 */
export function etdaCodeFor(docType: TaxInvoiceDto['documentType']): EtdaDocumentCode {
  switch (docType) {
    case 'TX':
      return 'T01';
    case 'ABB':
      return 'T02';
    case 'DN':
      return 'T03';
    case 'CN':
      return 'T04';
    case 'RE':
      return 'T05';
  }
}
