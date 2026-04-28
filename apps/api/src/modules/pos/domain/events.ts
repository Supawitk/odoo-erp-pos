export class OrderCompletedEvent {
  constructor(
    public readonly orderId: string,
    public readonly sessionId: string,
    public readonly totalCents: number,
    public readonly currency: string,
    public readonly createdAt: Date,
  ) {}
}
