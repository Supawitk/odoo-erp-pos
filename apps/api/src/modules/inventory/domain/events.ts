/**
 * Inventory domain events. Cross-module — consumed by:
 *   - Phase 3 web dashboard (low-stock badge, expiry alert UI)
 *   - Phase 4 accounting (StockMovedEvent → journal entry posting)
 *   - Phase 5 dashboard analytics (turnover, dead stock)
 */

export class StockMovedEvent {
  constructor(
    public readonly moveId: string,
    public readonly productId: string,
    public readonly moveType: string,
    public readonly qty: number, // signed
    public readonly fromWarehouseId: string | null,
    public readonly toWarehouseId: string | null,
    public readonly unitCostCents: number | null,
    public readonly sourceModule: string | null,
    public readonly sourceId: string | null,
    public readonly performedAt: Date,
  ) {}
}

/**
 * Fired once per POS order after the stock handler has processed every line.
 *
 * Carries the aggregated cost basis of the goods consumed (or returned, on a
 * refund). The accounting module listens to this to post the COGS leg:
 *   sale:    Dr 5100 COGS / Cr 1161 Finished goods
 *   refund:  Dr 1161 / Cr 5100   (reverses the sale)
 *
 * Separate from `OrderCompletedEvent` because:
 *   - the journal handler that listens to OrderCompletedEvent only knows the
 *     gross sale figures (revenue + VAT), not the cost basis
 *   - both handlers run concurrently, so the sale-side handler can't reliably
 *     query stock_moves and find them committed yet
 *   - chaining a follow-up event guarantees ordering: COGS posts only after
 *     the inventory side has stamped costs
 */
export class OrderStockConsumedEvent {
  constructor(
    public readonly orderId: string,
    /** Always positive. `isRefund` tells the journal handler which way to flip. */
    public readonly totalCostCents: number,
    public readonly isRefund: boolean,
    /** Number of lines that successfully recorded a cost — for logging. */
    public readonly costedLineCount: number,
    public readonly currency: string,
    public readonly occurredAt: Date,
  ) {}
}

export class LowStockAlertEvent {
  constructor(
    public readonly productId: string,
    public readonly productName: string,
    public readonly warehouseId: string,
    public readonly qtyOnHand: number,
    public readonly reorderPoint: number,
    public readonly suggestedReorderQty: number | null,
    public readonly occurredAt: Date,
  ) {}
}

export class LowExpiryAlertEvent {
  constructor(
    public readonly productId: string,
    public readonly costLayerId: string,
    public readonly lotCode: string | null,
    public readonly serialNo: string | null,
    public readonly qtyRemaining: number,
    public readonly expiryDate: Date,
    public readonly daysToExpiry: number,
    public readonly occurredAt: Date,
  ) {}
}
