import { Injectable } from '@nestjs/common';
import { JournalEntry, type JournalLine } from '../../domain/journal-entry';
import { JournalRepository } from '../../infrastructure/journal.repository';
import { TierValidationService } from '../../../approvals/tier-validation.service';

export interface ManualJournalInput {
  date: string;
  description: string;
  currency?: string;
  reference?: string | null;
  lines: JournalLine[];
  /** Manager / supervisor id whose authority bypasses the tier-validation gate. */
  approvedBy?: string;
  requestedBy?: string;
  /**
   * Client-generated idempotency key (UUID v7 recommended). When the first
   * submit is blocked by tier validation, the client should re-submit with
   * the SAME `id` so the pending review unblocks the same entry. When
   * omitted, a fresh id is generated and retries become a different entry.
   */
  id?: string;
}

@Injectable()
export class AccountingService {
  constructor(
    private readonly journals: JournalRepository,
    private readonly tier: TierValidationService,
  ) {}

  async postManual(input: ManualJournalInput, postedBy: string | null = null) {
    const entry = JournalEntry.create({
      id: input.id, // honour client idempotency key when supplied
      date: input.date,
      description: input.description,
      reference: input.reference ?? null,
      sourceModule: 'manual',
      sourceId: null,
      currency: input.currency ?? 'THB',
      lines: input.lines,
    });

    // Tier validation gate. Manual JEs are the highest-trust mutation in the
    // system (they edit the GL directly), so by default any non-trivial entry
    // routes through approval. The condition_expr in tier_definitions decides
    // the threshold; default seed: amount > 0 (i.e. all manual JEs gated).
    const totalDebits = input.lines.reduce(
      (s, l) => s + Math.abs(l.debitCents ?? 0),
      0,
    );
    // Tier-validation gate uses the entry's allocated id as the review target.
    // The repository will use this same id on insert, so an approved review
    // unblocks the exact JE that the next /api/accounting/journal-entries POST
    // creates (the controller passes input.id through to JournalEntry.create).
    //
    // The payload includes the full line set so the approver sees the ledger
    // mutation they're signing off on — without this, /approvals just shows
    // an amount with no context, and the entry doesn't yet exist in
    // journal_entries (the gate fires BEFORE persistence) so the deep-link
    // dead-ends. The approval inbox renders this payload inline.
    await this.tier.assertApproved({
      kind: 'accounting.je',
      targetId: entry.id,
      context: {
        amount: totalDebits,
        currency: input.currency ?? 'THB',
        date: input.date,
        description: input.description,
        reference: input.reference ?? null,
        // Compact line preview — accountCode + accountName + amounts.
        lines: input.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          description: l.description ?? null,
        })),
      },
      requestedBy: input.requestedBy ?? postedBy ?? undefined,
      preApprovedBy: input.approvedBy,
      comment: input.description,
    });

    return this.journals.insert(entry, { autoPost: true, postedBy });
  }

  voidEntry(id: string, reason: string, voidedBy: string | null = null) {
    return this.journals.void(id, reason, voidedBy);
  }
}
