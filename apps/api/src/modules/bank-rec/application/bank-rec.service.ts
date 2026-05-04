import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  bankMatchLinks,
  bankStatementLines,
  bankStatements,
  chartOfAccounts,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import {
  BankParseError,
  parseCsv,
  parseOfx,
  type ParsedBankLine,
  type ParsedStatement,
} from '../domain/parsers';
import {
  fingerprintInput,
  scoreMatch,
  suggestMatches,
  type BankLine,
  type JournalCandidate,
  type MatchSuggestion,
} from '../domain/matcher';

@Injectable()
export class BankRecService {
  private readonly logger = new Logger(BankRecService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ─── Import ─────────────────────────────────────────────────────────────
  /**
   * Import a bank-statement file. Source `auto` will sniff OFX vs CSV from
   * the first non-empty char (`<` → OFX, else CSV).
   *
   * Idempotency: file_hash collision (same file uploaded twice) → 409 with
   * the existing statement id. Per-line dedup uses the fingerprint UNIQUE
   * index, so re-importing a longer file that overlaps a prior one keeps
   * only the new lines.
   */
  async import(input: {
    cashAccountCode: string;
    bankLabel?: string;
    source: 'ofx' | 'csv' | 'auto';
    filename?: string;
    fileBytes: string;
    importedBy?: string;
  }) {
    if (!input.fileBytes?.trim()) {
      throw new BadRequestException('fileBytes empty');
    }
    await this.requireCashAccount(input.cashAccountCode);

    const fileHash = createHash('sha256').update(input.fileBytes).digest('hex');

    const [existing] = await this.db
      .select({ id: bankStatements.id })
      .from(bankStatements)
      .where(eq(bankStatements.fileHash, fileHash))
      .limit(1);
    if (existing) {
      throw new ConflictException({
        code: 'DUPLICATE_FILE',
        message: 'File already imported',
        existingStatementId: existing.id,
      });
    }

    const source: 'ofx' | 'csv' =
      input.source === 'auto'
        ? input.fileBytes.trimStart().startsWith('<')
          ? 'ofx'
          : 'csv'
        : input.source;

    let parsed: ParsedStatement;
    try {
      parsed = source === 'ofx' ? parseOfx(input.fileBytes) : parseCsv(input.fileBytes);
    } catch (e) {
      if (e instanceof BankParseError) {
        throw new BadRequestException(`${e.code}: ${e.message}`);
      }
      throw e;
    }

    const [stmtRow] = await this.db
      .insert(bankStatements)
      .values({
        cashAccountCode: input.cashAccountCode,
        bankLabel: input.bankLabel ?? parsed.bankLabel ?? 'Unnamed bank account',
        statementFrom: parsed.statementFrom,
        statementTo: parsed.statementTo,
        openingBalanceCents: parsed.openingBalanceCents,
        closingBalanceCents: parsed.closingBalanceCents,
        fileHash,
        source,
        filename: input.filename,
        importedBy: input.importedBy,
      })
      .returning();

    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < parsed.lines.length; i++) {
      const line = parsed.lines[i];
      const fingerprint = createHash('sha256')
        .update(fingerprintInput(line))
        .digest('hex');
      try {
        await this.db.insert(bankStatementLines).values({
          statementId: stmtRow.id,
          lineNo: i + 1,
          postedAt: line.postedAt,
          amountCents: line.amountCents,
          description: line.description || null,
          bankRef: line.bankRef,
          fingerprint,
        });
        inserted++;
      } catch (e: any) {
        // Fingerprint UNIQUE collision → already imported in a prior run.
        // Drizzle wraps the postgres-js error in DrizzleQueryError, so the
        // SQLSTATE code lives on `cause`.
        if (e?.code === '23505' || e?.cause?.code === '23505') {
          skipped++;
          continue;
        }
        throw e;
      }
    }

    this.logger.log(
      `Imported statement ${stmtRow.id} (${source}, ${parsed.lines.length} parsed → ${inserted} inserted, ${skipped} skipped as dupes)`,
    );
    return {
      statementId: stmtRow.id,
      cashAccountCode: input.cashAccountCode,
      bankLabel: stmtRow.bankLabel,
      from: stmtRow.statementFrom,
      to: stmtRow.statementTo,
      openingBalanceCents: stmtRow.openingBalanceCents,
      closingBalanceCents: stmtRow.closingBalanceCents,
      linesInserted: inserted,
      linesSkippedAsDuplicates: skipped,
    };
  }

  // ─── List statements + lines ───────────────────────────────────────────
  async listStatements(opts: { cashAccountCode?: string; limit?: number } = {}) {
    const where = [] as any[];
    if (opts.cashAccountCode)
      where.push(eq(bankStatements.cashAccountCode, opts.cashAccountCode));
    const rows = await this.db
      .select()
      .from(bankStatements)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(bankStatements.importedAt))
      .limit(Math.min(500, opts.limit ?? 100));

    // Per-statement counts of unmatched/matched lines.
    const stmtIds = rows.map((r) => r.id);
    const counts = stmtIds.length
      ? await this.db
          .select({
            statementId: bankStatementLines.statementId,
            status: bankStatementLines.status,
            count: sql<number>`count(*)::int`,
          })
          .from(bankStatementLines)
          .where(inArray(bankStatementLines.statementId, stmtIds))
          .groupBy(bankStatementLines.statementId, bankStatementLines.status)
      : [];

    const countByStmt = new Map<string, { unmatched: number; matched: number; ignored: number }>();
    for (const c of counts) {
      const e = countByStmt.get(c.statementId) ?? { unmatched: 0, matched: 0, ignored: 0 };
      (e as any)[c.status] = Number(c.count);
      countByStmt.set(c.statementId, e);
    }

    return rows.map((r) => ({
      id: r.id,
      cashAccountCode: r.cashAccountCode,
      bankLabel: r.bankLabel,
      statementFrom: r.statementFrom,
      statementTo: r.statementTo,
      openingBalanceCents: Number(r.openingBalanceCents ?? 0),
      closingBalanceCents: Number(r.closingBalanceCents ?? 0),
      source: r.source,
      filename: r.filename,
      importedAt: r.importedAt,
      counts:
        countByStmt.get(r.id) ?? { unmatched: 0, matched: 0, ignored: 0 },
    }));
  }

  async listLines(statementId: string) {
    const stmt = await this.db
      .select()
      .from(bankStatements)
      .where(eq(bankStatements.id, statementId))
      .limit(1);
    if (!stmt[0]) throw new NotFoundException(`Statement ${statementId} not found`);
    const lines = await this.db
      .select()
      .from(bankStatementLines)
      .where(eq(bankStatementLines.statementId, statementId))
      .orderBy(asc(bankStatementLines.lineNo));
    return {
      statement: {
        id: stmt[0].id,
        cashAccountCode: stmt[0].cashAccountCode,
        bankLabel: stmt[0].bankLabel,
        statementFrom: stmt[0].statementFrom,
        statementTo: stmt[0].statementTo,
      },
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        postedAt: l.postedAt,
        amountCents: Number(l.amountCents),
        description: l.description,
        bankRef: l.bankRef,
        status: l.status,
        journalEntryId: l.journalEntryId,
        matchedAt: l.matchedAt,
        notes: l.notes,
      })),
    };
  }

  // ─── Suggest matches for a single bank line ────────────────────────────
  /**
   * Pull JE candidates within ±dateWindowDays days of the bank line's
   * posted_at, on the same cash account, with no existing match link.
   * Score each via the pure matcher and return top-N.
   */
  async suggestForLine(
    bankLineId: string,
    opts: { dateWindowDays?: number; topN?: number } = {},
  ): Promise<MatchSuggestion[]> {
    const window = opts.dateWindowDays ?? 3;
    const topN = opts.topN ?? 5;

    const [bankLine] = await this.db
      .select({
        id: bankStatementLines.id,
        statementId: bankStatementLines.statementId,
        postedAt: bankStatementLines.postedAt,
        amountCents: bankStatementLines.amountCents,
        description: bankStatementLines.description,
        bankRef: bankStatementLines.bankRef,
      })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.id, bankLineId))
      .limit(1);
    if (!bankLine) throw new NotFoundException(`Bank line ${bankLineId} not found`);

    const [stmt] = await this.db
      .select({ cashAccountCode: bankStatements.cashAccountCode })
      .from(bankStatements)
      .where(eq(bankStatements.id, bankLine.statementId))
      .limit(1);
    if (!stmt) throw new NotFoundException('Parent statement missing');

    const fromDate = this.shiftDate(String(bankLine.postedAt), -window);
    const toDate = this.shiftDate(String(bankLine.postedAt), window);

    // Pull JE-line candidates: posted, on same cash account, in date window,
    // and NOT already matched. Net per JE because a single JE can have
    // multiple lines on the cash account (rare but possible — e.g. card
    // settlement that splits cash + fees).
    const candidatesRaw = await this.db
      .select({
        id: journalEntries.id,
        date: journalEntries.date,
        description: journalEntries.description,
        reference: journalEntries.reference,
        sourceModule: journalEntries.sourceModule,
        sourceId: journalEntries.sourceId,
        netCents: sql<number>`(sum(${journalEntryLines.debitCents}) - sum(${journalEntryLines.creditCents}))::bigint`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .leftJoin(
        bankMatchLinks,
        eq(bankMatchLinks.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          eq(journalEntryLines.accountCode, stmt.cashAccountCode),
          gte(journalEntries.date, fromDate),
          lte(journalEntries.date, toDate),
          isNull(bankMatchLinks.id),
        ),
      )
      .groupBy(
        journalEntries.id,
        journalEntries.date,
        journalEntries.description,
        journalEntries.reference,
        journalEntries.sourceModule,
        journalEntries.sourceId,
      );

    const candidates: JournalCandidate[] = candidatesRaw.map((c) => ({
      id: c.id,
      date: String(c.date),
      amountCents: Number(c.netCents),
      description: c.description,
      reference: c.reference,
      sourceModule: c.sourceModule,
      sourceId: c.sourceId,
    }));

    const bankInput: BankLine = {
      id: bankLine.id,
      postedAt: String(bankLine.postedAt),
      amountCents: Number(bankLine.amountCents),
      description: bankLine.description ?? '',
      bankRef: bankLine.bankRef,
    };

    return suggestMatches(bankInput, candidates).slice(0, topN);
  }

  // ─── Confirm a match ────────────────────────────────────────────────────
  /**
   * Link a bank line to one or more journal entries. Sum of `amountCents`
   * across links must equal the bank line amount. Idempotent: re-confirming
   * the SAME pairing → 409 (the bml_journal_unique_idx prevents double-link).
   */
  async confirmMatch(
    bankLineId: string,
    input: {
      links: Array<{
        journalEntryId: string;
        amountCents: number;
        sourceModule?: string;
        sourceId?: string;
      }>;
      matchedBy?: string;
    },
  ) {
    if (!input.links?.length) {
      throw new BadRequestException('At least one link required');
    }

    return await this.db.transaction(async (tx) => {
      const [bankLine] = await tx
        .select()
        .from(bankStatementLines)
        .where(eq(bankStatementLines.id, bankLineId))
        .limit(1)
        .for('update');
      if (!bankLine) throw new NotFoundException(`Bank line ${bankLineId} not found`);
      if (bankLine.status === 'matched') {
        throw new BadRequestException('Bank line already matched');
      }
      if (bankLine.status === 'ignored') {
        throw new BadRequestException('Bank line is ignored — un-ignore first');
      }

      const linkSum = input.links.reduce((s, l) => s + l.amountCents, 0);
      if (linkSum !== Number(bankLine.amountCents)) {
        throw new BadRequestException(
          `Sum of link amounts (${linkSum}) must equal bank line amount (${bankLine.amountCents})`,
        );
      }

      try {
        await tx.insert(bankMatchLinks).values(
          input.links.map((l) => ({
            bankLineId,
            journalEntryId: l.journalEntryId,
            sourceModule: l.sourceModule ?? null,
            sourceId: l.sourceId ?? null,
            amountCents: l.amountCents,
            matchedBy: input.matchedBy ?? null,
          })),
        );
      } catch (e: any) {
        if (e?.code === '23505' || e?.cause?.code === '23505') {
          throw new ConflictException(
            'One of the journal entries is already matched to a different bank line',
          );
        }
        throw e;
      }

      await tx
        .update(bankStatementLines)
        .set({
          status: 'matched',
          journalEntryId: input.links[input.links.length - 1].journalEntryId,
          matchedAt: new Date(),
          matchedBy: input.matchedBy ?? null,
        })
        .where(eq(bankStatementLines.id, bankLineId));

      this.logger.log(
        `Bank line ${bankLineId} matched to ${input.links.length} JE(s) totalling ${linkSum}`,
      );
      return { bankLineId, linkCount: input.links.length, totalCents: linkSum };
    });
  }

  // ─── Unmatch (reverse a confirm) ────────────────────────────────────────
  async unmatch(bankLineId: string) {
    return await this.db.transaction(async (tx) => {
      const [bankLine] = await tx
        .select()
        .from(bankStatementLines)
        .where(eq(bankStatementLines.id, bankLineId))
        .limit(1)
        .for('update');
      if (!bankLine) throw new NotFoundException(`Bank line ${bankLineId} not found`);
      if (bankLine.status !== 'matched') {
        throw new BadRequestException(`Bank line is ${bankLine.status}, not matched`);
      }
      await tx.delete(bankMatchLinks).where(eq(bankMatchLinks.bankLineId, bankLineId));
      await tx
        .update(bankStatementLines)
        .set({
          status: 'unmatched',
          journalEntryId: null,
          matchedAt: null,
          matchedBy: null,
        })
        .where(eq(bankStatementLines.id, bankLineId));
      return { bankLineId, status: 'unmatched' };
    });
  }

  // ─── Mark a bank line as ignored ────────────────────────────────────────
  async ignore(bankLineId: string, reason: string) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Reason required (≥3 chars)');
    }
    const [bankLine] = await this.db
      .select()
      .from(bankStatementLines)
      .where(eq(bankStatementLines.id, bankLineId))
      .limit(1);
    if (!bankLine) throw new NotFoundException(`Bank line ${bankLineId} not found`);
    if (bankLine.status === 'matched') {
      throw new BadRequestException('Cannot ignore a matched line — unmatch first');
    }
    await this.db
      .update(bankStatementLines)
      .set({ status: 'ignored', notes: reason })
      .where(eq(bankStatementLines.id, bankLineId));
    return { bankLineId, status: 'ignored' };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  private async requireCashAccount(code: string) {
    const [acc] = await this.db
      .select({ code: chartOfAccounts.code, type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.code, code))
      .limit(1);
    if (!acc) {
      throw new BadRequestException(`Account ${code} not in chart of accounts`);
    }
    if (acc.type !== 'asset') {
      throw new BadRequestException(
        `Account ${code} is type=${acc.type}; bank reconciliation requires an asset (cash) account`,
      );
    }
  }

  private shiftDate(iso: string, deltaDays: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }
}
