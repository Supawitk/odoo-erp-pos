import { Injectable } from '@nestjs/common';
import { JournalEntry, type JournalLine } from '../../domain/journal-entry';
import { JournalRepository } from '../../infrastructure/journal.repository';

export interface ManualJournalInput {
  date: string;
  description: string;
  currency?: string;
  reference?: string | null;
  lines: JournalLine[];
}

@Injectable()
export class AccountingService {
  constructor(private readonly journals: JournalRepository) {}

  async postManual(input: ManualJournalInput, postedBy: string | null = null) {
    const entry = JournalEntry.create({
      date: input.date,
      description: input.description,
      reference: input.reference ?? null,
      sourceModule: 'manual',
      sourceId: null,
      currency: input.currency ?? 'THB',
      lines: input.lines,
    });
    return this.journals.insert(entry, { autoPost: true, postedBy });
  }

  voidEntry(id: string, reason: string, voidedBy: string | null = null) {
    return this.journals.void(id, reason, voidedBy);
  }
}
