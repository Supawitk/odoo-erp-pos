/**
 * 🇹🇭 Document-type domain — picks the correct Thai POS document per
 * Revenue Code §86/4 (full tax invoice) vs §86/6 (abbreviated retail tax
 * invoice). Non-VAT-registered merchants always issue a plain Receipt.
 *
 * Decision rules:
 *   vatRegistered = false               → RE  (receipt only)
 *   buyer TIN supplied                  → TX  (full tax invoice)
 *   no TIN + total ≤ ฿1,000             → ABB (abbreviated tax invoice)
 *   no TIN + total >  ฿1,000            → ABB still legal but system PROMPTS
 *                                         cashier to ask for TIN so buyer can
 *                                         claim input VAT. Accepts if they
 *                                         refuse.
 *
 * CN (credit note) is decided separately in the refund/void flow.
 */

export type DocumentType = 'RE' | 'ABB' | 'TX' | 'CN';

export interface BuyerInfo {
  name?: string;
  tin?: string; // 13 digits
  branch?: string; // 5 digits
  address?: string;
}

export interface DocumentDecisionInput {
  vatRegistered: boolean;
  buyer?: BuyerInfo;
  totalCents: number;
  abbreviatedCapCents: number;
}

export interface DocumentDecision {
  type: Exclude<DocumentType, 'CN'>;
  /** If true, UI should advise cashier to capture TIN before posting. */
  suggestAskTIN: boolean;
  reason: string;
}

export function decideDocumentType(input: DocumentDecisionInput): DocumentDecision {
  if (!input.vatRegistered) {
    return { type: 'RE', suggestAskTIN: false, reason: 'merchant not VAT-registered' };
  }
  if (input.buyer?.tin) {
    return { type: 'TX', suggestAskTIN: false, reason: 'buyer TIN supplied' };
  }
  const suggestAskTIN = input.totalCents > input.abbreviatedCapCents;
  return {
    type: 'ABB',
    suggestAskTIN,
    reason: suggestAskTIN
      ? `total ${input.totalCents / 100} THB > ${input.abbreviatedCapCents / 100} THB cap — suggest TIN`
      : 'abbreviated tax invoice allowed',
  };
}

/** Prefix helper: TX2604 for period 202604. */
export function prefixFor(type: Exclude<DocumentType, 'CN'>, period: string): string {
  // YYYYMM → YYMM
  const yyMm = period.slice(2);
  return `${type}${yyMm}`;
}

/** Format a final document number: "TX2604-000042". */
export function formatDocumentNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
