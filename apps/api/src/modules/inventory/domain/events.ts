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
