/**
 * Inventory domain errors. Phase 3 — surfaces:
 *   - InsufficientStockError: stock_quants.qty_on_hand - qty_reserved < requested
 *   - WarehouseNotFoundError: caller asked for a warehouse code that doesn't exist
 *   - VarianceRequiresApprovalError: cycle-count or adjustment exceeds auto-accept threshold
 *   - NegativeStockNotAllowedError: a move would push qty below zero (overrides require approvedBy)
 */

export class InventoryDomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = code;
  }
}

export class InsufficientStockError extends InventoryDomainError {
  constructor(
    public readonly productId: string,
    public readonly warehouseId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      'INSUFFICIENT_STOCK',
      `Insufficient stock for product ${productId} at warehouse ${warehouseId}: requested ${requested}, available ${available}`,
    );
  }
}

export class WarehouseNotFoundError extends InventoryDomainError {
  constructor(idOrCode: string) {
    super('WAREHOUSE_NOT_FOUND', `Warehouse not found: ${idOrCode}`);
  }
}

export class VarianceRequiresApprovalError extends InventoryDomainError {
  constructor(varianceCents: number, thresholdCents: number) {
    super(
      'VARIANCE_REQUIRES_APPROVAL',
      `Variance ${varianceCents} satang exceeds auto-accept threshold ${thresholdCents}; provide approvedBy`,
    );
  }
}

export class NegativeStockNotAllowedError extends InventoryDomainError {
  constructor(productId: string, warehouseId: string, wouldGoTo: number) {
    super(
      'NEGATIVE_STOCK_NOT_ALLOWED',
      `Move would drop qty for product ${productId} at warehouse ${warehouseId} to ${wouldGoTo}`,
    );
  }
}
