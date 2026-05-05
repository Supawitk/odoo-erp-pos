import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, lte, sql, isNotNull } from 'drizzle-orm';
import {
  chartOfAccounts,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import {
  donationCap,
  entertainmentCap,
  parseCategory,
  summariseByCategory,
  type CapMath,
  type NonDeductibleCategory,
} from './non-deductible.calculator';

export interface NonDeductibleRow {
  jeLineId: string;
  journalEntryId: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  category: NonDeductibleCategory;
  cents: number;
  reason: string | null;
  description: string | null;
}

export interface NonDeductibleRegister {
  fiscalYear: number;
  halfYear: boolean;
  periodFrom: string;
  periodTo: string;
  totalCents: number;
  byCategory: Record<NonDeductibleCategory, number>;
  /** Computed cap math for entertainment + donations — surfaces over-cap amounts even if not yet flagged. */
  caps: {
    entertainment: CapMath & { account: string; eligibleSpentCents: number };
    donations: CapMath & { account: string };
  };
  rows: NonDeductibleRow[];
  /**
   * Lines the auto-flag rules WOULD touch but haven't yet. The UI shows
   * these as "suggestions" so the operator can review before applying.
   */
  suggestions: Array<{
    jeLineId: string;
    accountCode: string;
    accountName: string;
    suggestedCategory: NonDeductibleCategory;
    suggestedCents: number;
    reason: string;
  }>;
}

/**
 * Accounts that should always 100%-flag when posted to. Conservative defaults
 * matching the Thai SME CoA we ship; operators can override per-line.
 */
const ALWAYS_NON_DEDUCTIBLE: Record<string, NonDeductibleCategory> = {
  '9110': 'cit_self', // Corporate income tax expense
};

// Account codes match the Thai SME seed in chart-of-accounts.seed.ts. Pinned
// here as constants because the auto-flag rules and cap-math reads target
// these specific accounts; renaming a CoA code requires touching both files.
const ENTERTAINMENT_ACCOUNT = '6210'; // ค่ารับรอง — §65 ter (4) capped
const DONATIONS_ACCOUNT = '6220'; // เงินบริจาค — §65 ter (3)(b) capped
// 6230 Fines & penalties intentionally NOT in ALWAYS_NON_DEDUCTIBLE — operator
// must manually flag with a reason (audit trail per §65 ter (6)).
const RESERVES_ACCOUNTS = ['6240']; // ค่าเผื่อหนี้สงสัยจะสูญ — §65 ter (1)

@Injectable()
export class NonDeductibleService {
  private readonly logger = new Logger(NonDeductibleService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Build the full register for a fiscal period.
   */
  async register(opts: {
    fiscalYear: number;
    halfYear: boolean;
    revenueCents: number;
    expenseCents: number;
    paidInCapitalCents: number;
    annualisedRevenueCents: number;
  }): Promise<NonDeductibleRegister> {
    const fy = opts.fiscalYear;
    const periodFrom = `${fy}-01-01`;
    const periodTo = opts.halfYear ? `${fy}-06-30` : `${fy}-12-31`;

    // Already-flagged lines.
    const flagged = await this.db
      .select({
        jeLineId: journalEntryLines.id,
        journalEntryId: journalEntries.id,
        entryDate: journalEntries.date,
        accountCode: journalEntryLines.accountCode,
        accountName: journalEntryLines.accountName,
        category: journalEntryLines.nonDeductibleCategory,
        cents: journalEntryLines.nonDeductibleCents,
        reason: journalEntryLines.nonDeductibleReason,
        description: journalEntryLines.description,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, periodFrom),
          lte(journalEntries.date, periodTo),
          isNotNull(journalEntryLines.nonDeductibleCategory),
          sql`${journalEntryLines.nonDeductibleCents} > 0`,
        ),
      );

    const rows: NonDeductibleRow[] = flagged
      .filter((r) => parseCategory(r.category) !== null)
      .map((r) => ({
        jeLineId: r.jeLineId,
        journalEntryId: r.journalEntryId,
        entryDate: r.entryDate,
        accountCode: r.accountCode,
        accountName: r.accountName,
        category: r.category as NonDeductibleCategory,
        cents: Number(r.cents),
        reason: r.reason,
        description: r.description,
      }));

    const summary = summariseByCategory(rows.map((r) => ({ category: r.category, cents: r.cents })));

    // Cap math — entertainment + donations.
    const entSpent = await this.sumDebitOnAccount(periodFrom, periodTo, ENTERTAINMENT_ACCOUNT);
    const donSpent = await this.sumDebitOnAccount(periodFrom, periodTo, DONATIONS_ACCOUNT);

    const entCap = entertainmentCap({
      annualRevenueCents: opts.annualisedRevenueCents,
      paidInCapitalCents: opts.paidInCapitalCents,
      actualEntertainmentCents: entSpent,
    });
    const donCap = donationCap({
      revenueCents: opts.revenueCents,
      expenseCents: opts.expenseCents,
      actualDonationsCents: donSpent,
    });

    // Already-flagged entertainment / donation amounts — to subtract from
    // suggestions so we don't double-suggest.
    const flaggedEntCents = rows
      .filter((r) => r.accountCode === ENTERTAINMENT_ACCOUNT)
      .reduce((s, r) => s + r.cents, 0);
    const flaggedDonCents = rows
      .filter((r) => r.accountCode === DONATIONS_ACCOUNT)
      .reduce((s, r) => s + r.cents, 0);

    const suggestions = await this.buildSuggestions({
      periodFrom,
      periodTo,
      entOverCap: Math.max(0, entCap.overCapCents - flaggedEntCents),
      entReason: entCap.reason,
      donOverCap: Math.max(0, donCap.overCapCents - flaggedDonCents),
      donReason: donCap.reason,
    });

    return {
      fiscalYear: fy,
      halfYear: opts.halfYear,
      periodFrom,
      periodTo,
      totalCents: summary.totalCents,
      byCategory: summary.byCategory,
      caps: {
        entertainment: { ...entCap, account: ENTERTAINMENT_ACCOUNT, eligibleSpentCents: entSpent },
        donations: { ...donCap, account: DONATIONS_ACCOUNT },
      },
      rows: rows.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
      suggestions,
    };
  }

  /**
   * Manually flag a single JE line as non-deductible.
   */
  async flag(opts: {
    jeLineId: string;
    category: NonDeductibleCategory;
    cents: number;
    reason: string | null;
  }) {
    if (opts.cents <= 0) {
      throw new BadRequestException('cents must be > 0');
    }
    if (opts.category === 'fines_penalties' && (!opts.reason || opts.reason.trim().length < 3)) {
      throw new BadRequestException('reason is required for fines_penalties (audit trail)');
    }

    // Validate the line exists + the cents don't exceed the line's debit amount.
    const line = await this.db
      .select({
        id: journalEntryLines.id,
        debitCents: journalEntryLines.debitCents,
        creditCents: journalEntryLines.creditCents,
        accountCode: journalEntryLines.accountCode,
      })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.id, opts.jeLineId))
      .limit(1);
    if (line.length === 0) {
      throw new NotFoundException(`Journal entry line ${opts.jeLineId} not found`);
    }
    const lineAmount = Math.max(Number(line[0].debitCents), Number(line[0].creditCents));
    if (opts.cents > lineAmount) {
      throw new BadRequestException(
        `cents (${opts.cents}) exceeds line amount (${lineAmount})`,
      );
    }

    await this.db
      .update(journalEntryLines)
      .set({
        nonDeductibleCategory: opts.category,
        nonDeductibleCents: opts.cents,
        nonDeductibleReason: opts.reason,
      })
      .where(eq(journalEntryLines.id, opts.jeLineId));

    return { jeLineId: opts.jeLineId, flagged: true };
  }

  /**
   * Clear a flag.
   */
  async unflag(jeLineId: string) {
    const result = await this.db
      .update(journalEntryLines)
      .set({
        nonDeductibleCategory: null,
        nonDeductibleCents: 0,
        nonDeductibleReason: null,
      })
      .where(eq(journalEntryLines.id, jeLineId));
    return { jeLineId, flagged: false };
  }

  /**
   * Apply auto-rules for a period. Idempotent — safe to re-run.
   *
   * Rules:
   *   1. Account 9110 (CIT) lines — flag 100% as `cit_self`. CIT itself is
   *      always non-deductible per §65 ter (6).
   *   2. Account 6160 (bad-debt provision) — flag 100% as reserves_provisions.
   *      §65 ter (1) — generic reserves not deductible.
   *   3. Entertainment over cap — flag the EXCESS proportionally across the
   *      period's entertainment lines.
   *   4. Donations over cap — same proportional flag.
   *
   * What we DON'T auto-flag:
   *   - personal / non_business / undocumented — judgment calls; require
   *     manual flag with reason.
   *   - capital_expensed — needs the operator to decide whether the line is
   *     capex disguised as opex.
   *   - fines_penalties — the description usually identifies these but we
   *     need the operator's confirmation, since "fee" can be either.
   */
  async autoFlag(opts: {
    fiscalYear: number;
    halfYear: boolean;
    revenueCents: number;
    expenseCents: number;
    paidInCapitalCents: number;
    annualisedRevenueCents: number;
  }): Promise<{ flaggedCount: number; flaggedCents: number }> {
    const fy = opts.fiscalYear;
    const periodFrom = `${fy}-01-01`;
    const periodTo = opts.halfYear ? `${fy}-06-30` : `${fy}-12-31`;

    let flaggedCount = 0;
    let flaggedCents = 0;

    // Rule 1 + 2: 100% flag for always-non-deductible accounts.
    for (const [code, category] of Object.entries(ALWAYS_NON_DEDUCTIBLE)) {
      const result = await this.flagAccount100Pct(periodFrom, periodTo, code, category);
      flaggedCount += result.count;
      flaggedCents += result.cents;
    }
    for (const code of RESERVES_ACCOUNTS) {
      const result = await this.flagAccount100Pct(
        periodFrom,
        periodTo,
        code,
        'reserves_provisions',
      );
      flaggedCount += result.count;
      flaggedCents += result.cents;
    }

    // Rule 3: entertainment over cap.
    const entSpent = await this.sumDebitOnAccount(periodFrom, periodTo, ENTERTAINMENT_ACCOUNT);
    const entCap = entertainmentCap({
      annualRevenueCents: opts.annualisedRevenueCents,
      paidInCapitalCents: opts.paidInCapitalCents,
      actualEntertainmentCents: entSpent,
    });
    if (entCap.overCapCents > 0) {
      const result = await this.flagOverCapProrated({
        periodFrom,
        periodTo,
        accountCode: ENTERTAINMENT_ACCOUNT,
        category: 'entertainment_over_cap',
        overCapCents: entCap.overCapCents,
        reason: entCap.reason,
      });
      flaggedCount += result.count;
      flaggedCents += result.cents;
    }

    // Rule 4: donations over cap.
    const donSpent = await this.sumDebitOnAccount(periodFrom, periodTo, DONATIONS_ACCOUNT);
    const donCap = donationCap({
      revenueCents: opts.revenueCents,
      expenseCents: opts.expenseCents,
      actualDonationsCents: donSpent,
    });
    if (donCap.overCapCents > 0) {
      const result = await this.flagOverCapProrated({
        periodFrom,
        periodTo,
        accountCode: DONATIONS_ACCOUNT,
        category: 'donations_over_cap',
        overCapCents: donCap.overCapCents,
        reason: donCap.reason,
      });
      flaggedCount += result.count;
      flaggedCents += result.cents;
    }

    return { flaggedCount, flaggedCents };
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async sumDebitOnAccount(from: string, to: string, accountCode: string): Promise<number> {
    const r = await this.db
      .select({
        sum: sql<number>`coalesce(sum(${journalEntryLines.debitCents} - ${journalEntryLines.creditCents}), 0)::bigint`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
          eq(journalEntryLines.accountCode, accountCode),
        ),
      );
    return Number(r[0]?.sum ?? 0);
  }

  private async flagAccount100Pct(
    from: string,
    to: string,
    accountCode: string,
    category: NonDeductibleCategory,
  ): Promise<{ count: number; cents: number }> {
    // Two-step: SELECT eligible lines for the count + total, THEN UPDATE.
    // (Drizzle's `db.execute(sql\`...RETURNING\`)` shape varies between
    // drivers — postgres-js doesn't put rows in `.rows` like pg does — so
    // we use the typed query builder instead and avoid the wrapper-shape mess.)
    const eligible = await this.db
      .select({
        id: journalEntryLines.id,
        debitCents: journalEntryLines.debitCents,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
          eq(journalEntryLines.accountCode, accountCode),
          sql`${journalEntryLines.debitCents} > 0`,
          sql`(${journalEntryLines.nonDeductibleCategory} IS NULL OR ${journalEntryLines.nonDeductibleCents} = 0)`,
        ),
      );
    if (eligible.length === 0) return { count: 0, cents: 0 };

    let cents = 0;
    for (const line of eligible) {
      const debit = Number(line.debitCents);
      await this.db
        .update(journalEntryLines)
        .set({
          nonDeductibleCategory: category,
          nonDeductibleCents: debit,
          nonDeductibleReason: `Auto-flag: account ${accountCode} is always non-deductible`,
        })
        .where(eq(journalEntryLines.id, line.id));
      cents += debit;
    }
    return { count: eligible.length, cents };
  }

  /**
   * Flag entertainment / donation lines over the cap proportionally.
   *
   * Algorithm: walk the period's debit lines on `accountCode` ordered by id,
   * assigning the over-cap remainder ฿-by-฿ — each line gets either its full
   * debit (if remaining over-cap > line) or the residual (the last touched
   * line gets the truncation crumb).
   */
  private async flagOverCapProrated(opts: {
    periodFrom: string;
    periodTo: string;
    accountCode: string;
    category: NonDeductibleCategory;
    overCapCents: number;
    reason: string;
  }): Promise<{ count: number; cents: number }> {
    const lines = await this.db
      .select({
        id: journalEntryLines.id,
        debitCents: journalEntryLines.debitCents,
        currentFlag: journalEntryLines.nonDeductibleCents,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, opts.periodFrom),
          lte(journalEntries.date, opts.periodTo),
          eq(journalEntryLines.accountCode, opts.accountCode),
          sql`${journalEntryLines.debitCents} > 0`,
        ),
      )
      .orderBy(journalEntryLines.id);

    let remaining = opts.overCapCents;
    let count = 0;
    let cents = 0;
    for (const line of lines) {
      if (remaining <= 0) break;
      const debit = Number(line.debitCents);
      const slice = Math.min(remaining, debit);
      // Idempotency: if line is already flagged with the same category at the
      // same or higher amount, skip. Otherwise overwrite.
      const currentCents = Number(line.currentFlag);
      if (currentCents >= slice) {
        // Already covered — don't double-count.
        remaining -= currentCents;
        continue;
      }
      await this.db
        .update(journalEntryLines)
        .set({
          nonDeductibleCategory: opts.category,
          nonDeductibleCents: slice,
          nonDeductibleReason: `Auto-flag: ${opts.reason}`,
        })
        .where(eq(journalEntryLines.id, line.id));
      remaining -= slice;
      count++;
      cents += slice;
    }
    return { count, cents };
  }

  private async buildSuggestions(opts: {
    periodFrom: string;
    periodTo: string;
    entOverCap: number;
    entReason: string;
    donOverCap: number;
    donReason: string;
  }) {
    const out: Awaited<ReturnType<NonDeductibleService['register']>>['suggestions'] = [];

    // Always-non-deductible accounts (9110, 6160) that haven't been flagged.
    const accountsToCheck: Array<{ code: string; cat: NonDeductibleCategory; reason: string }> = [];
    for (const [code, cat] of Object.entries(ALWAYS_NON_DEDUCTIBLE)) {
      accountsToCheck.push({ code, cat, reason: `Account ${code} is always non-deductible (§65 ter)` });
    }
    for (const code of RESERVES_ACCOUNTS) {
      accountsToCheck.push({
        code,
        cat: 'reserves_provisions',
        reason: `Account ${code} (reserves) is non-deductible (§65 ter (1))`,
      });
    }
    for (const a of accountsToCheck) {
      const lines = await this.db
        .select({
          id: journalEntryLines.id,
          accountCode: journalEntryLines.accountCode,
          accountName: journalEntryLines.accountName,
          debitCents: journalEntryLines.debitCents,
          flagCents: journalEntryLines.nonDeductibleCents,
        })
        .from(journalEntryLines)
        .innerJoin(
          journalEntries,
          eq(journalEntryLines.journalEntryId, journalEntries.id),
        )
        .where(
          and(
            eq(journalEntries.status, 'posted'),
            gte(journalEntries.date, opts.periodFrom),
            lte(journalEntries.date, opts.periodTo),
            eq(journalEntryLines.accountCode, a.code),
            sql`${journalEntryLines.debitCents} > ${journalEntryLines.nonDeductibleCents}`,
          ),
        );
      for (const l of lines) {
        out.push({
          jeLineId: l.id,
          accountCode: l.accountCode,
          accountName: l.accountName,
          suggestedCategory: a.cat,
          suggestedCents: Number(l.debitCents) - Number(l.flagCents),
          reason: a.reason,
        });
      }
    }

    // Entertainment over cap — single roll-up suggestion (the auto-rule
    // distributes; we just surface the total here).
    if (opts.entOverCap > 0) {
      out.push({
        jeLineId: '__entertainment_overall__',
        accountCode: ENTERTAINMENT_ACCOUNT,
        accountName: 'Entertainment & hospitality',
        suggestedCategory: 'entertainment_over_cap',
        suggestedCents: opts.entOverCap,
        reason: opts.entReason,
      });
    }
    if (opts.donOverCap > 0) {
      out.push({
        jeLineId: '__donations_overall__',
        accountCode: DONATIONS_ACCOUNT,
        accountName: 'Donations',
        suggestedCategory: 'donations_over_cap',
        suggestedCents: opts.donOverCap,
        reason: opts.donReason,
      });
    }

    return out;
  }
}
