import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql, and, lte, gte, desc, type SQL } from 'drizzle-orm';
import {
  chartOfAccounts,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalEntry } from '../domain/journal-entry';
import {
  JournalEntryNotFoundError,
  PostedEntryImmutableError,
  UnknownAccountError,
} from '../domain/errors';

export interface JournalEntryRow {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  sourceModule: string | null;
  sourceId: string | null;
  currency: string;
  totalDebitCents: number;
  totalCreditCents: number;
  status: 'draft' | 'posted' | 'voided';
  voidedById: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface JournalEntryLineRow {
  id: string;
  journalEntryId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  description: string | null;
  partnerId: string | null;
}

export interface JournalEntryWithLines extends JournalEntryRow {
  lines: JournalEntryLineRow[];
}

@Injectable()
export class JournalRepository {
  private readonly logger = new Logger(JournalRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Persist a new journal entry. The aggregate has already enforced
   * debit=credit at construction; the database trigger is the second line of
   * defence on transition to `posted`.
   */
  async insert(
    entry: JournalEntry,
    options: { autoPost?: boolean; postedBy?: string | null } = {},
  ): Promise<JournalEntryRow> {
    const { autoPost = false, postedBy = null } = options;

    // Validate every account code exists — saves the user from typos that
    // would otherwise trip the FK constraint with a less helpful error.
    const codes = [...new Set(entry.lines.map((l) => l.accountCode))];
    const found = await this.db
      .select({ code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(sql`${chartOfAccounts.code} IN ${codes}`);
    const known = new Set(found.map((r) => r.code));
    for (const c of codes) {
      if (!known.has(c)) throw new UnknownAccountError(c);
    }

    // Lock the FK by adding it lazily once at startup — done by the seeder.
    return this.db.transaction(async (tx) => {
      const [header] = await tx
        .insert(journalEntries)
        .values({
          date: entry.date,
          description: entry.description,
          reference: entry.reference ?? undefined,
          sourceModule: entry.sourceModule ?? undefined,
          sourceId: entry.sourceId ?? undefined,
          currency: entry.currency,
          status: 'draft', // always start as draft so the trigger can pick up totals
        })
        .returning();

      await tx.insert(journalEntryLines).values(
        entry.lines.map((l) => ({
          journalEntryId: header.id,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          currency: entry.currency,
          description: l.description ?? null,
          partnerId: l.partnerId ?? null,
        })),
      );

      if (autoPost) {
        // The status transition fires the balance trigger which also fills
        // total_debit_cents / total_credit_cents.
        const [posted] = await tx
          .update(journalEntries)
          .set({
            status: 'posted',
            postedAt: new Date(),
            postedBy: postedBy ?? undefined,
          })
          .where(eq(journalEntries.id, header.id))
          .returning();
        return mapHeader(posted);
      }
      return mapHeader(header);
    });
  }

  /** Set status='posted' on a draft entry. Trigger does the validation. */
  async post(id: string, postedBy: string | null = null): Promise<JournalEntryRow> {
    const cur = await this.findHeader(id);
    if (!cur) throw new JournalEntryNotFoundError(id);
    if (cur.status === 'posted') return cur;
    if (cur.status === 'voided') {
      throw new PostedEntryImmutableError(id);
    }
    const [updated] = await this.db
      .update(journalEntries)
      .set({
        status: 'posted',
        postedAt: new Date(),
        postedBy: postedBy ?? undefined,
      })
      .where(eq(journalEntries.id, id))
      .returning();
    return mapHeader(updated);
  }

  /**
   * Void a posted entry by inserting an OFFSETTING entry with debits/credits
   * flipped, then marking both as void-linked. The original row is not edited
   * — that's how we keep an audit trail.
   */
  async void(
    id: string,
    reason: string,
    voidedBy: string | null = null,
  ): Promise<{ original: JournalEntryRow; offset: JournalEntryRow }> {
    const original = await this.findWithLines(id);
    if (!original) throw new JournalEntryNotFoundError(id);
    if (original.status !== 'posted') {
      throw new PostedEntryImmutableError(id);
    }

    return this.db.transaction(async (tx) => {
      const [offsetHeader] = await tx
        .insert(journalEntries)
        .values({
          date: new Date().toISOString().slice(0, 10),
          description: `VOID of ${original.id} — ${reason}`,
          reference: original.reference ?? undefined,
          sourceModule: 'void',
          sourceId: original.id,
          currency: original.currency,
          status: 'draft',
        })
        .returning();

      await tx.insert(journalEntryLines).values(
        original.lines.map((l) => ({
          journalEntryId: offsetHeader.id,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitCents: l.creditCents,
          creditCents: l.debitCents,
          currency: l.currency,
          description: `void of line ${l.id}`,
          partnerId: l.partnerId,
        })),
      );

      const [postedOffset] = await tx
        .update(journalEntries)
        .set({
          status: 'posted',
          postedAt: new Date(),
          postedBy: voidedBy ?? undefined,
        })
        .where(eq(journalEntries.id, offsetHeader.id))
        .returning();

      const [voidedOriginal] = await tx
        .update(journalEntries)
        .set({ status: 'voided', voidedById: postedOffset.id })
        .where(eq(journalEntries.id, original.id))
        .returning();

      return {
        original: mapHeader(voidedOriginal),
        offset: mapHeader(postedOffset),
      };
    });
  }

  async findHeader(id: string): Promise<JournalEntryRow | null> {
    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, id))
      .limit(1);
    return rows[0] ? mapHeader(rows[0]) : null;
  }

  async findWithLines(id: string): Promise<JournalEntryWithLines | null> {
    const header = await this.findHeader(id);
    if (!header) return null;
    const lines = await this.db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, id));
    return { ...header, lines: lines.map(mapLine) };
  }

  /**
   * List entries with simple filters. `from` / `to` bound the accounting
   * `date`, not the createdAt — closing the books works in business calendar.
   */
  async list(opts: {
    from?: string;
    to?: string;
    status?: 'draft' | 'posted' | 'voided';
    sourceModule?: string;
    limit?: number;
  }): Promise<JournalEntryRow[]> {
    const where: SQL[] = [];
    if (opts.from) where.push(gte(journalEntries.date, opts.from));
    if (opts.to) where.push(lte(journalEntries.date, opts.to));
    if (opts.status) where.push(eq(journalEntries.status, opts.status));
    if (opts.sourceModule)
      where.push(eq(journalEntries.sourceModule, opts.sourceModule));
    const whereClause = where.length > 0 ? and(...where) : undefined;
    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(whereClause)
      .orderBy(desc(journalEntries.date), desc(journalEntries.entryNumber))
      .limit(Math.min(500, opts.limit ?? 100));
    return rows.map(mapHeader);
  }

  /** Trial balance as of an inclusive date. Sums posted lines per account. */
  async trialBalance(asOfDate: string): Promise<
    Array<{
      accountCode: string;
      accountName: string;
      type: string;
      normalBalance: 'debit' | 'credit';
      debitCents: number;
      creditCents: number;
      balanceCents: number; // signed by normal-balance side
    }>
  > {
    const rows = await this.db
      .select({
        accountCode: journalEntryLines.accountCode,
        accountName: chartOfAccounts.name,
        type: chartOfAccounts.type,
        normalBalance: chartOfAccounts.normalBalance,
        debit: sql<number>`coalesce(sum(${journalEntryLines.debitCents}), 0)`,
        credit: sql<number>`coalesce(sum(${journalEntryLines.creditCents}), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .innerJoin(
        chartOfAccounts,
        eq(journalEntryLines.accountCode, chartOfAccounts.code),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          lte(journalEntries.date, asOfDate),
        ),
      )
      .groupBy(
        journalEntryLines.accountCode,
        chartOfAccounts.name,
        chartOfAccounts.type,
        chartOfAccounts.normalBalance,
      )
      .orderBy(journalEntryLines.accountCode);

    return rows.map((r) => {
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      const balance = r.normalBalance === 'debit' ? debit - credit : credit - debit;
      return {
        accountCode: r.accountCode,
        accountName: r.accountName,
        type: r.type,
        normalBalance: r.normalBalance as 'debit' | 'credit',
        debitCents: debit,
        creditCents: credit,
        balanceCents: balance,
      };
    });
  }
}

function mapHeader(row: any): JournalEntryRow {
  return {
    id: row.id,
    entryNumber: Number(row.entryNumber ?? row.entry_number ?? 0),
    date: typeof row.date === 'string' ? row.date : new Date(row.date).toISOString().slice(0, 10),
    description: row.description,
    reference: row.reference ?? null,
    sourceModule: row.sourceModule ?? row.source_module ?? null,
    sourceId: row.sourceId ?? row.source_id ?? null,
    currency: row.currency,
    totalDebitCents: Number(row.totalDebitCents ?? row.total_debit_cents ?? 0),
    totalCreditCents: Number(row.totalCreditCents ?? row.total_credit_cents ?? 0),
    status: row.status,
    voidedById: row.voidedById ?? row.voided_by_id ?? null,
    postedAt:
      row.postedAt instanceof Date
        ? row.postedAt.toISOString()
        : row.postedAt ?? row.posted_at ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt ?? row.created_at,
  };
}

function mapLine(row: any): JournalEntryLineRow {
  return {
    id: row.id,
    journalEntryId: row.journalEntryId ?? row.journal_entry_id,
    accountCode: row.accountCode ?? row.account_code,
    accountName: row.accountName ?? row.account_name,
    debitCents: Number(row.debitCents ?? row.debit_cents ?? 0),
    creditCents: Number(row.creditCents ?? row.credit_cents ?? 0),
    currency: row.currency,
    description: row.description ?? null,
    partnerId: row.partnerId ?? row.partner_id ?? null,
  };
}
