import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { journalEntries, journalEntryLines, chartOfAccounts } from '@erp/db';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';

export interface CashBookLine {
  date: string;
  entryNumber: number;
  journalEntryId: string;
  description: string;
  reference: string | null;
  sourceModule: string | null;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number; // running balance
}

export interface CashBookReport {
  from: string;
  to: string;
  cashAccounts: Array<{ code: string; name: string }>;
  openingBalanceCents: number;
  closingBalanceCents: number;
  netChangeCents: number;
  lines: CashBookLine[];
}

/**
 * Statutory Cash Book (สมุดเงินสด) — every debit and credit posted to cash
 * accounts (1110 cash on hand, 1120 checking, 1130 savings, etc.) in
 * chronological order with a running balance. Required by §17 Accounting Act
 * B.E. 2543 as one of the seven mandatory statutory books.
 *
 * Running balance is computed by starting from the opening balance (all
 * posted JEs before `from`) and summing each line in date + entry_number
 * order. The balance reflects the NET debit-normal position: positive = cash
 * asset, negative = overdraft.
 */
@Injectable()
export class CashBookService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async report(opts: { from: string; to: string }): Promise<CashBookReport> {
    // 1. Resolve cash accounts (isCashAccount=true in CoA)
    const cashRows = await this.db
      .select({ code: chartOfAccounts.code, name: chartOfAccounts.name })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.isCashAccount, true));

    const cashCodes: string[] = cashRows.map((r: any) => r.code);
    const cashAccountList: Array<{ code: string; name: string }> = cashRows;

    if (cashCodes.length === 0) {
      return {
        from: opts.from, to: opts.to, cashAccounts: [],
        openingBalanceCents: 0, closingBalanceCents: 0, netChangeCents: 0,
        lines: [],
      };
    }

    // 2. Opening balance: sum of all posted JEs before `from` on cash accounts
    const [{ opening }] = await this.db
      .select({
        opening: sql<number>`coalesce(sum(${journalEntryLines.debitCents}) - sum(${journalEntryLines.creditCents}), 0)::bigint`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          inArray(journalEntryLines.accountCode, cashCodes),
          sql`${journalEntries.date} < ${opts.from}`,
        ),
      );

    const openingBalance = Number(opening);

    // 3. Lines in the period
    const rows = await this.db
      .select({
        date: journalEntries.date,
        entryNumber: journalEntries.entryNumber,
        journalEntryId: journalEntries.id,
        description: journalEntries.description,
        reference: journalEntries.reference,
        sourceModule: journalEntries.sourceModule,
        accountCode: journalEntryLines.accountCode,
        accountName: journalEntryLines.description, // line-level name fallback
        debitCents: journalEntryLines.debitCents,
        creditCents: journalEntryLines.creditCents,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          inArray(journalEntryLines.accountCode, cashCodes),
          gte(journalEntries.date, opts.from),
          lte(journalEntries.date, opts.to),
        ),
      )
      .orderBy(journalEntries.date, journalEntries.entryNumber);

    // 4. Build running balance
    let running = openingBalance;
    const lines: CashBookLine[] = rows.map((r: any) => {
      const dr = Number(r.debitCents);
      const cr = Number(r.creditCents);
      running += dr - cr;
      const accountName =
        cashAccountList.find((a) => a.code === r.accountCode)?.name ?? r.accountCode;
      return {
        date: r.date,
        entryNumber: r.entryNumber,
        journalEntryId: r.journalEntryId,
        description: r.description,
        reference: r.reference,
        sourceModule: r.sourceModule,
        accountCode: r.accountCode,
        accountName,
        debitCents: dr,
        creditCents: cr,
        balanceCents: running,
      };
    });

    const closingBalance = running;

    return {
      from: opts.from,
      to: opts.to,
      cashAccounts: cashAccountList,
      openingBalanceCents: openingBalance,
      closingBalanceCents: closingBalance,
      netChangeCents: closingBalance - openingBalance,
      lines,
    };
  }
}
