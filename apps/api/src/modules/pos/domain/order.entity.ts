import {
  EmptyOrderError,
  InsufficientPaymentError,
} from './errors';
import type { DocumentType } from './document';

export type PaymentMethod = 'cash' | 'card' | 'split' | 'promptpay';
export type OrderStatus = 'draft' | 'paid' | 'refunded' | 'voided';

export interface OrderLineData {
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  /** VAT category per-line (inherits merchant default if absent). */
  vatCategory?: 'standard' | 'zero_rated' | 'exempt';
  /** Per-line discount (post-discount = qty * unitPrice - discountCents). */
  discountCents?: number;
  /** Server-hydrated: 🇹🇭 excise satang for this line (alcohol/tobacco/sugar). Added to VAT base. */
  exciseCents?: number;
  /** Server-computed: net after discount + excise, before VAT. */
  netCents?: number;
  /** Server-computed: VAT on this line. */
  vatCents?: number;
  /** Server-computed: gross = net + vat. */
  grossCents?: number;
}

export interface PaymentData {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents?: number;
  changeCents?: number;
  cardLast4?: string;
  promptpaySlipSsid?: string;
}

export interface BuyerData {
  name?: string;
  tin?: string;
  branch?: string;
  address?: string;
}

export interface VatBreakdown {
  taxableNetCents: number;
  zeroRatedNetCents: number;
  exemptNetCents: number;
  vatCents: number;
  grossCents: number;
  /** 🇹🇭 Sum of excise across all lines. Already included in taxableNetCents/grossCents. */
  exciseCents?: number;
}

export interface OrderProps {
  id: string;
  offlineId: string;
  sessionId: string;
  customerId?: string;
  buyer?: BuyerData;
  lines: OrderLineData[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  vatBreakdown: VatBreakdown;
  currency: string;
  payment: PaymentData;
  status: OrderStatus;
  documentType: DocumentType;
  documentNumber?: string;
  promptpayRef?: string;
  originalOrderId?: string;
  iPadDeviceId?: string;
  createdAt: Date;
}

/**
 * Order aggregate root.
 *
 * Server is authoritative on money: caller passes lines + (optional) buyer +
 * payment; server computes subtotal, discount, VAT, total, and the document
 * type. The client's totals never enter the domain.
 */
export class Order {
  private constructor(private readonly props: OrderProps) {}

  static create(props: OrderProps): Order {
    if (props.lines.length === 0) {
      throw new EmptyOrderError();
    }

    // Belt-and-suspenders arithmetic check — server computed these, but a
    // coding regression here would corrupt every single sale.
    const sumGross = props.lines.reduce((s, l) => s + (l.grossCents ?? 0), 0);
    if (Math.abs(sumGross - props.totalCents) > 1) {
      throw new Error(
        `Order sumGross=${sumGross} vs totalCents=${props.totalCents} drift > 1 satang`,
      );
    }

    if (props.payment.amountCents < props.totalCents) {
      throw new InsufficientPaymentError(props.totalCents, props.payment.amountCents);
    }

    if (
      props.payment.method === 'cash' &&
      props.payment.tenderedCents !== undefined
    ) {
      const expectedChange = props.payment.tenderedCents - props.totalCents;
      if (expectedChange < 0) {
        throw new InsufficientPaymentError(props.totalCents, props.payment.tenderedCents);
      }
    }

    return new Order(props);
  }

  get id() {
    return this.props.id;
  }
  get offlineId() {
    return this.props.offlineId;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get customerId() {
    return this.props.customerId;
  }
  get buyer() {
    return this.props.buyer;
  }
  get lines() {
    return this.props.lines;
  }
  get subtotalCents() {
    return this.props.subtotalCents;
  }
  get discountCents() {
    return this.props.discountCents;
  }
  get taxCents() {
    return this.props.taxCents;
  }
  get totalCents() {
    return this.props.totalCents;
  }
  get vatBreakdown() {
    return this.props.vatBreakdown;
  }
  get currency() {
    return this.props.currency;
  }
  get payment() {
    return this.props.payment;
  }
  get status() {
    return this.props.status;
  }
  get documentType() {
    return this.props.documentType;
  }
  get documentNumber() {
    return this.props.documentNumber;
  }
  get promptpayRef() {
    return this.props.promptpayRef;
  }
  get originalOrderId() {
    return this.props.originalOrderId;
  }
  get iPadDeviceId() {
    return this.props.iPadDeviceId;
  }
  get createdAt() {
    return this.props.createdAt;
  }

  toSnapshot(): OrderProps {
    return { ...this.props };
  }
}
