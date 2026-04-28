import type { BuyerData, OrderLineData, PaymentData } from '../../domain/order.entity';

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
  ) {}
}
