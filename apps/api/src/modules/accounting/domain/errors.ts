/** Journal entry whose debit total ≠ credit total — fundamental double-entry violation. */
export class UnbalancedEntryError extends Error {
  readonly code = 'UNBALANCED_ENTRY';
  constructor(public readonly debitCents: number, public readonly creditCents: number) {
    super(
      `Journal entry is unbalanced: debits=${debitCents} credits=${creditCents} (Δ=${debitCents - creditCents})`,
    );
    this.name = 'UnbalancedEntryError';
  }
}

/** Account code referenced on a line is not in the chart of accounts. */
export class UnknownAccountError extends Error {
  readonly code = 'UNKNOWN_ACCOUNT';
  constructor(public readonly accountCode: string) {
    super(`Unknown account code: ${accountCode}`);
    this.name = 'UnknownAccountError';
  }
}

/** Trying to mutate a posted entry — must be voided + offset, never edited in place. */
export class PostedEntryImmutableError extends Error {
  readonly code = 'POSTED_ENTRY_IMMUTABLE';
  constructor(public readonly entryId: string) {
    super(`Journal entry ${entryId} is posted; create a void/offset instead of mutating`);
    this.name = 'PostedEntryImmutableError';
  }
}

/** Trying to add lines to or modify a journal entry that doesn't exist. */
export class JournalEntryNotFoundError extends Error {
  readonly code = 'JOURNAL_ENTRY_NOT_FOUND';
  constructor(public readonly entryId: string) {
    super(`Journal entry ${entryId} not found`);
    this.name = 'JournalEntryNotFoundError';
  }
}
