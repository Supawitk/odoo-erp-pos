/**
 * 🇹🇭 Debit-note command (§86/9 — ใบเพิ่มหนี้).
 *
 * Issued when an already-posted tax invoice needs to be increased after the
 * fact: price was understated, qty was under-counted, additional charge
 * needs to be added with reference to the original invoice.
 *
 * Unlike a CN (which is a subset of original lines, refunded), a DN is
 * additional charges with their own line shapes. The seller and buyer
 * blocks copy from the original invoice; the DN is a follow-on document
 * that points back to the source via originalOrderId.
 */
export class DebitOrderCommand {
  constructor(
    public readonly originalOrderId: string,
    public readonly reason: string,
    public readonly additionalLines: Array<{
      description: string;
      qty: number;
      unitPriceCents: number;
      vatCategory?: 'standard' | 'zero_rated' | 'exempt';
    }>,
    public readonly approvedBy?: string,
  ) {}
}
