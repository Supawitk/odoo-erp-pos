export class RefundOrderCommand {
  constructor(
    public readonly originalOrderId: string,
    /** Free-form reason printed on the credit note (required under §86/10). */
    public readonly reason: string,
    /** Who authorised the refund — will be verified against manager role later. */
    public readonly approvedBy: string,
    /**
     * Optional partial refund: array of { lineIndex, qtyToRefund, unitPriceCents }.
     * Omitted = full refund of the whole order.
     */
    public readonly partialLines?: Array<{
      lineIndex: number;
      qty: number;
    }>,
  ) {}
}
