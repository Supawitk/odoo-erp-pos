export class RefundOrderCommand {
  constructor(
    public readonly originalOrderId: string,
    /** Free-form reason printed on the credit note (required under §86/10). */
    public readonly reason: string,
    /**
     * Manager / supervisor user-id whose authority bypasses the tier-validation
     * gate when present in the rule's reviewer list. When omitted, the refund
     * is gated by any matching tier rule and the caller gets ApprovalRequired.
     */
    public readonly approvedBy: string,
    /**
     * Optional partial refund: array of { lineIndex, qtyToRefund, unitPriceCents }.
     * Omitted = full refund of the whole order.
     */
    public readonly partialLines?: Array<{
      lineIndex: number;
      qty: number;
    }>,
    /** Filer of the request (cashier user-id), distinct from approvedBy. */
    public readonly requestedBy?: string,
  ) {}
}
