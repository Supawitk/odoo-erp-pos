/**
 * Purchasing domain errors. All map to 422 via DomainExceptionFilter.
 */
export class PurchasingDomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = code;
  }
}

export class InvalidSupplierTinError extends PurchasingDomainError {
  constructor(public readonly tin: string) {
    super('INVALID_SUPPLIER_TIN', `Supplier TIN failed mod-11 checksum: ${tin}`);
  }
}

export class PurchaseOrderStateError extends PurchasingDomainError {
  constructor(
    public readonly poId: string,
    public readonly current: string,
    public readonly attempted: string,
  ) {
    super(
      'PO_STATE_TRANSITION_INVALID',
      `Purchase order ${poId} cannot transition from ${current} to ${attempted}`,
    );
  }
}

export class GrnQuantityExceedsPoError extends PurchasingDomainError {
  constructor(
    public readonly poLineId: string,
    public readonly requested: number,
    public readonly remaining: number,
  ) {
    super(
      'GRN_QTY_EXCEEDS_PO',
      `GRN line for PO line ${poLineId} requests ${requested}, only ${remaining} remaining`,
    );
  }
}

export class GoodsReceiptStateError extends PurchasingDomainError {
  constructor(
    public readonly grnId: string,
    public readonly current: string,
    public readonly attempted: string,
  ) {
    super(
      'GRN_STATE_TRANSITION_INVALID',
      `Goods receipt ${grnId} cannot transition from ${current} to ${attempted}`,
    );
  }
}
