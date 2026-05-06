import type { BuyerData, OrderLineData, PaymentData } from '../../domain/order.entity';

export type RestaurantOrderType = 'dine_in' | 'takeout' | 'delivery';

export class CreateOrderCommand {
  constructor(
    public readonly offlineId: string,
    public readonly sessionId: string,
    public readonly customerId: string | undefined,
    public readonly buyer: BuyerData | undefined,
    public readonly lines: OrderLineData[],
    public readonly cartDiscountCents: number,
    public readonly currency: string,
    public readonly vatMode: 'inclusive' | 'exclusive' | undefined,
    public readonly payment: PaymentData,
    public readonly iPadDeviceId: string | undefined,
    /** Restaurant mode (Pro flag) — null for retail. */
    public readonly orderType: RestaurantOrderType | null = null,
    public readonly tableNumber: string | null = null,
    /** Cash tip in satang. Non-VAT, paid on top of order total. */
    public readonly tipCents: number = 0,
    /** Set when this order is a child of a split. */
    public readonly splitParentId: string | null = null,
  ) {}
}
