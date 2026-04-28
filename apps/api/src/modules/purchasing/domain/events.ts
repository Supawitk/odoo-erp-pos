/**
 * Purchasing domain events — consumed by:
 *   - InventoryModule (GoodsReceivedEvent → receiveStock per QC-passed line)
 *   - Phase 4 accounting (PurchaseOrderConfirmedEvent → commitment journal)
 *   - Phase 5 dashboard (PO velocity analytics)
 */

export class PurchaseOrderConfirmedEvent {
  constructor(
    public readonly poId: string,
    public readonly poNumber: string,
    public readonly supplierId: string,
    public readonly totalCents: number,
    public readonly currency: string,
    public readonly confirmedAt: Date,
  ) {}
}

export class GoodsReceivedEvent {
  constructor(
    public readonly grnId: string,
    public readonly grnNumber: string,
    public readonly poId: string,
    public readonly supplierId: string,
    public readonly destinationWarehouseId: string,
    public readonly lines: ReadonlyArray<{
      grnLineId: string;
      poLineId: string;
      productId: string;
      qtyAccepted: number;
      unitCostCents: number;
      qcStatus: 'passed' | 'failed' | 'quarantine' | 'pending';
      lotCode: string | null;
      serialNo: string | null;
      expiryDate: string | null;
    }>,
    public readonly receivedAt: Date,
  ) {}
}
