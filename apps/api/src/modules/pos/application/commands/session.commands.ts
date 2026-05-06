export class OpenSessionCommand {
  constructor(
    public readonly userId: string,
    public readonly openingBalanceCents: number,
    public readonly deviceId?: string,
    /** 🇹🇭 §86/4 branch code — gates multi-branch document sequences. Default '00000' = HQ. */
    public readonly branchCode: string = '00000',
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
