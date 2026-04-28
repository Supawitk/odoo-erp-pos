export class OpenSessionCommand {
  constructor(
    public readonly userId: string,
    public readonly openingBalanceCents: number,
    public readonly deviceId?: string,
  ) {}
}

export class CloseSessionCommand {
  constructor(
    public readonly sessionId: string,
    /** Cashier's blind count — server computes expected + variance. */
    public readonly countedBalanceCents: number,
    public readonly varianceApprovedBy?: string,
  ) {}
}
