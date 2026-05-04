import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  chartOfAccounts,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../infrastructure/journal.repository';

/**
 * The "Big Three" financial statements + the supporting Net Income figure.
 * All built on top of `JournalRepository.trialBalance()` so the totals
 * always tie to the trial balance — meaning if the trial balance is in
 * balance, the BS will balance and the PL will reconcile to retained earnings.
 *
 * Account-type → statement mapping (TFRS for NPAEs, mirroring the seed CoA):
 *   asset     → Balance Sheet (current + non-current)
 *   liability → Balance Sheet (current + non-current)
 *   equity    → Balance Sheet
 *   revenue   → Profit & Loss
 *   expense   → Profit & Loss
 *
 * Closing-entry convention: PL accounts are NOT explicitly closed to
 * Retained Earnings here — instead the BS shows Retained Earnings as the
 * sum of (closed prior periods) + (current-period Net Income). That keeps
 * the system live: any new sale instantly moves both PL and BS without
 * needing a period-close ritual.
 *
 * Cash-flow categorisation uses `source_module` on the JE rather than
 * deriving it from line semantics. That's pragmatic for an SME — if a JE
 * came from a sales/purchase event it's operating; if from a fixed-asset
 * event (Phase 4 fixed-asset register, future) it's investing; if from a
 * loan/equity event it's financing. Until those modules ship we class
 * everything as operating, which is correct for service-only SMEs.
 */
@Injectable()
export class FinancialStatementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
  ) {}

  // ─── Profit & Loss for a period ─────────────────────────────────────────
  /**
   * Revenue and expense roll-up for [from, to] inclusive.
   *
   * Net Income = Revenue (credit balance) − Expense (debit balance).
   * We use signed `balanceCents` from the same logic as the trial balance:
   * for revenue (credit-normal) balance == credit − debit; for expense
   * (debit-normal) balance == debit − credit. So `revenue − expense` here
   * is always the right sign for net income.
   */
  async profitLoss(opts: { from: string; to: string }): Promise<{
    from: string;
    to: string;
    revenue: { rows: AccountRow[]; totalCents: number };
    expense: { rows: AccountRow[]; totalCents: number };
    netIncomeCents: number;
  }> {
    const rows = await this.aggregatePeriod(opts.from, opts.to);

    const revenue = rows.filter((r) => r.type === 'revenue');
    const expense = rows.filter((r) => r.type === 'expense');

    // Section totals use the SECTION's natural side, not the per-account
    // normal_balance flag. This matters for contra accounts: 4140 sales
    // returns (revenue, debit-normal) is a credit-side reduction of net
    // revenue. Per-row balance still uses normal_balance so the line
    // displays as a positive number, but the section total nets correctly.
    const revenueTotal = sumNaturalSide(revenue, 'credit');
    const expenseTotal = sumNaturalSide(expense, 'debit');

    return {
      from: opts.from,
      to: opts.to,
      revenue: { rows: revenue, totalCents: revenueTotal },
      expense: { rows: expense, totalCents: expenseTotal },
      netIncomeCents: revenueTotal - expenseTotal,
    };
  }

  // ─── Balance Sheet at a point in time ───────────────────────────────────
  /**
   * Balance Sheet as of an inclusive date.
   *
   * Equity is augmented with the period-to-date Net Income aggregated from
   * fiscal-year-start to asOf. Without this the BS would be off by exactly
   * the unclosed PL — exactly the trial-balance check `assets == liabilities
   * + equity + (revenue − expense)` rearranged. Adding NI to equity makes
   * the BS balance.
   *
   * Fiscal year start defaults to Jan 1 of the asOf year. Override via
   * `fiscalYearStart` when the org runs a non-calendar year.
   */
  async balanceSheet(opts: {
    asOf: string;
    fiscalYearStart?: string;
  }): Promise<{
    asOf: string;
    assets: { rows: AccountRow[]; totalCents: number };
    liabilities: { rows: AccountRow[]; totalCents: number };
    equity: { rows: AccountRow[]; totalCents: number; netIncomeYtdCents: number };
    totals: {
      assetsCents: number;
      liabilitiesPlusEquityCents: number;
      deltaCents: number; // must be 0
    };
  }> {
    const tb = (await this.journals.trialBalance(opts.asOf)).map((r) => ({
      ...r,
      type: r.type as AccountRow['type'],
    }));

    const fyStart = opts.fiscalYearStart ?? `${opts.asOf.slice(0, 4)}-01-01`;
    const ytd = await this.profitLoss({ from: fyStart, to: opts.asOf });

    const assets = tb.filter((r) => r.type === 'asset');
    const liabilities = tb.filter((r) => r.type === 'liability');
    const equity = tb.filter((r) => r.type === 'equity');

    // Section totals use natural side. Contra-asset (1590 accumulated
    // depreciation, credit-normal) ends up subtracted from gross asset
    // because it's credit-balance and asset's natural side is debit:
    // sum(debit - credit) over asset rows naturally nets the contra.
    const assetsTotal = sumNaturalSide(assets, 'debit');
    const liabilitiesTotal = sumNaturalSide(liabilities, 'credit');
    const equityTotalRaw = sumNaturalSide(equity, 'credit');
    const equityTotal = equityTotalRaw + ytd.netIncomeCents;

    return {
      asOf: opts.asOf,
      assets: { rows: assets, totalCents: assetsTotal },
      liabilities: { rows: liabilities, totalCents: liabilitiesTotal },
      equity: {
        rows: equity,
        totalCents: equityTotal,
        netIncomeYtdCents: ytd.netIncomeCents,
      },
      totals: {
        assetsCents: assetsTotal,
        liabilitiesPlusEquityCents: liabilitiesTotal + equityTotal,
        deltaCents: assetsTotal - (liabilitiesTotal + equityTotal),
      },
    };
  }

  // ─── Cash Flow for a period ─────────────────────────────────────────────
  /**
   * Indirect-method cash flow categorised by the `source_module` of each
   * journal entry that touched a cash account (1110 cash on hand, 1120
   * checking, 1130 savings, 1135 card receivable in transit).
   *
   * For each cash account, we sum debits − credits per source_module bucket:
   *
   *   operating   — pos.order, sales.invoice*, purchasing.bill*, accounting.manual
   *   investing   — fixed-asset (future), inventory.adjust significant moves
   *   financing   — loan/equity events (future)
   *   void        — reversals (preserved separately for audit)
   *
   * Net change in cash for the period = Σ(operating + investing + financing).
   * Verifies against direct delta: cash balance at `to` minus at `from − 1d`.
   */
  async cashFlow(opts: { from: string; to: string }): Promise<{
    from: string;
    to: string;
    cashAccounts: string[];
    operatingCents: number;
    investingCents: number;
    financingCents: number;
    voidedCents: number;
    netChangeCents: number;
    openingCashCents: number;
    closingCashCents: number;
    deltaCents: number; // must be 0
    bySource: Array<{ sourceModule: string; bucket: 'operating' | 'investing' | 'financing' | 'void'; deltaCents: number }>;
  }> {
    // Cash + cash equivalents — sourced from chart_of_accounts where
    // is_cash_account=true. Anyone adding a new bank account in the future
    // just toggles the flag and it lights up here without a code change.
    // 1135 (card-in-transit) and 1100 (parent) are deliberately NOT flagged
    // in the seed — they are settlement / grouping accounts, not cash.
    const cashRows = await this.db
      .select({ code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.isCashAccount, true),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .orderBy(asc(chartOfAccounts.code));
    const cashAccounts = cashRows.map((r) => r.code);
    if (cashAccounts.length === 0) {
      // Defensive: an org with no flagged cash accounts → all zero, no rows
      // joined. Without this guard `inArray([])` would produce SQL
      // `IN ()` which Postgres rejects.
      return {
        from: opts.from,
        to: opts.to,
        cashAccounts: [],
        operatingCents: 0,
        investingCents: 0,
        financingCents: 0,
        voidedCents: 0,
        netChangeCents: 0,
        openingCashCents: 0,
        closingCashCents: 0,
        deltaCents: 0,
        bySource: [],
      };
    }

    // Per-source rollup over the period. Use Drizzle's typed query builder
    // so `inArray` expands the JS array into a proper Postgres parameter
    // (raw `= ANY(${array})` template fails because postgres-js doesn't
    // auto-cast JS arrays in inline expressions).
    const rows = await this.db
      .select({
        sourceModule: journalEntries.sourceModule,
        netCents: sql<number>`coalesce(sum(${journalEntryLines.debitCents} - ${journalEntryLines.creditCents}), 0)::bigint`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, opts.from),
          lte(journalEntries.date, opts.to),
          inArray(journalEntryLines.accountCode, cashAccounts),
        ),
      )
      .groupBy(journalEntries.sourceModule);

    let operating = 0;
    let investing = 0;
    let financing = 0;
    let voided = 0;
    const bySource: Array<{
      sourceModule: string;
      bucket: 'operating' | 'investing' | 'financing' | 'void';
      deltaCents: number;
    }> = [];

    for (const r of rows) {
      const src = r.sourceModule ?? '(unknown)';
      const delta = Number(r.netCents);
      const bucket = classifySource(src);
      if (bucket === 'operating') operating += delta;
      else if (bucket === 'investing') investing += delta;
      else if (bucket === 'financing') financing += delta;
      else voided += delta;
      bySource.push({ sourceModule: src, bucket, deltaCents: delta });
    }

    // Opening cash = sum of cash-account balances strictly before `from`.
    // Closing cash = sum at `to` (inclusive). The delta should equal
    // operating + investing + financing + voided. Voided lines are kept in
    // the bucket break-out so reversal entries don't silently disappear.
    const openingCash = await this.cashBalanceAt(this.dayBefore(opts.from), cashAccounts);
    const closingCash = await this.cashBalanceAt(opts.to, cashAccounts);
    const netChange = operating + investing + financing + voided;

    return {
      from: opts.from,
      to: opts.to,
      cashAccounts,
      operatingCents: operating,
      investingCents: investing,
      financingCents: financing,
      voidedCents: voided,
      netChangeCents: netChange,
      openingCashCents: openingCash,
      closingCashCents: closingCash,
      deltaCents: closingCash - openingCash - netChange,
      bySource: bySource.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.sourceModule.localeCompare(b.sourceModule)),
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────
  private async aggregatePeriod(from: string, to: string): Promise<AccountRow[]> {
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
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .innerJoin(chartOfAccounts, eq(journalEntryLines.accountCode, chartOfAccounts.code))
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
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
        type: r.type as AccountRow['type'],
        normalBalance: r.normalBalance as 'debit' | 'credit',
        debitCents: debit,
        creditCents: credit,
        balanceCents: balance,
      };
    });
  }

  private async cashBalanceAt(asOf: string, accounts: string[]): Promise<number> {
    const [row] = await this.db
      .select({
        balance: sql<number>`coalesce(sum(${journalEntryLines.debitCents} - ${journalEntryLines.creditCents}), 0)::bigint`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          lte(journalEntries.date, asOf),
          inArray(journalEntryLines.accountCode, accounts),
        ),
      );
    return Number(row?.balance ?? 0);
  }

  private dayBefore(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}

export interface AccountRow {
  accountCode: string;
  accountName: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

/**
 * Source-module → cash-flow bucket mapping. Conservative: anything not
 * recognised falls into 'operating' (the safe default for SMEs that don't
 * yet have investing/financing activity). Reversals tracked separately.
 */
function classifySource(src: string): 'operating' | 'investing' | 'financing' | 'void' {
  if (src === 'void') return 'void';
  if (src.startsWith('fixed-asset.')) return 'investing';
  if (src.startsWith('loan.') || src.startsWith('equity.')) return 'financing';
  return 'operating';
}

/**
 * Sum a section by its natural side (debit or credit). Per-row `balanceCents`
 * is signed by each account's normal_balance flag — fine for display but
 * wrong for section roll-ups when the section contains contra accounts
 * (e.g. 4140 sales returns inside revenue, 1590 accum-depreciation inside
 * asset). Net section total = Σ(debit − credit) for debit-natural sections,
 * Σ(credit − debit) for credit-natural sections.
 */
function sumNaturalSide(rows: AccountRow[], side: 'debit' | 'credit'): number {
  if (side === 'debit') {
    return rows.reduce((s, r) => s + (r.debitCents - r.creditCents), 0);
  }
  return rows.reduce((s, r) => s + (r.creditCents - r.debitCents), 0);
}
