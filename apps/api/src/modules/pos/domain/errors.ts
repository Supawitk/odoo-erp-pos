export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export class EmptyOrderError extends DomainError {
  constructor() {
    super('EMPTY_ORDER', 'Order must have at least one line');
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(detail: string) {
    super('INVALID_MONEY', `Invalid money amount: ${detail}`);
  }
}

export class TotalsMismatchError extends DomainError {
  constructor(clientTotal: number, serverTotal: number) {
    super(
      'TOTALS_MISMATCH',
      `Client total ${clientTotal} does not match server-computed total ${serverTotal}`,
    );
  }
}

export class SessionNotOpenError extends DomainError {
  constructor() {
    super('SESSION_NOT_OPEN', 'POS session is not open');
  }
}

export class InsufficientPaymentError extends DomainError {
  constructor(required: number, tendered: number) {
    super(
      'INSUFFICIENT_PAYMENT',
      `Tendered ${tendered} cents is less than required ${required} cents`,
    );
  }
}

export class InvalidBuyerTinError extends DomainError {
  constructor(tin: string) {
    super('INVALID_BUYER_TIN', `Buyer TIN "${tin}" failed mod-11 checksum`);
  }
}

export class OrderNotFoundError extends DomainError {
  constructor(id: string) {
    super('ORDER_NOT_FOUND', `Order ${id} not found`);
  }
}

export class OrderAlreadyRefundedError extends DomainError {
  constructor(id: string) {
    super('ORDER_ALREADY_REFUNDED', `Order ${id} is already refunded or voided`);
  }
}

export class RefundNotAllowedError extends DomainError {
  constructor(reason: string) {
    super('REFUND_NOT_ALLOWED', `Refund not allowed: ${reason}`);
  }
}
