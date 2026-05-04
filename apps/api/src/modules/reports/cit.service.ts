import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import {
  chartOfAccounts,
  citFilings,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { FinancialStatementsService } from '../accounting/application/financial-statements.service';
import { JournalRepository } from '../accounting/infrastructure/journal.repository';
import { JournalEntry } from '../accounting/domain/journal-entry';
import { computeCit, type CitCalcInput } from './cit.calculator';

export interface CitPreviewResult {
  fiscalYear: number;
  halfYear: boolean;
  /** Calendar window the calculation read [from, to). */
  periodFrom: string;
  periodTo: string;

  /** Inputs that drove the calc — surfaced for the UI explanation. */
  revenueCents: number;
  expenseCents: number;
  taxableIncomeCents: number;
  paidInCapitalCents: number;
  annualisedRevenueCents: number;

  /** Tax math. */
  taxDueCents: number;
  rateBracket: 'sme' | 'flat20';
  breakdown: ReturnType<typeof computeCit>['breakdown'];

  /** Credits available against the tax due. */
  whtCreditsCents: number;
  advancePaidCents: number;
  netPayableCents: number;

  /** True when this period already has a row in cit_filings. */
  alreadyFiled: boolean;
  filing: {
    id: string;
    filedAt: string;
    filedBy: string | null;
    rdFilingReference: string | null;
    notes: string | null;
    netPayableCents: number;
  } | null;

  /** Warnings the user should see before filing. */
  warnings: string[];
}

@Injectable()
export class CitService {
  private readonly logger = new Logger(CitService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly financials: FinancialStatementsService,
    private readonly journals: JournalRepository,
  ) {}

  /**
   * Preview the CIT calculation. Reads net income from the existing P&L
   * service so depreciation, COGS, etc. all flow through correctly.
   *
   * For PND.51 (half-year): reads H1 only (Jan–Jun for a calendar fiscal
   * year), then doubles the tax due as the half-year *estimate* per RD
   * convention. The tax due is half the projected annual liability —
   * literally `computeCit(annual taxable income) / 2`. We approximate by
   * doubling H1 income and running it through the bracket calc, then
   * halving the result; for many SMEs this matches close enough.
   */
  async preview(opts: {
    fiscalYear: number;
    halfYear: boolean;
    /** Optional override for paid-in capital (defaults to ฿1M assumption). */
    paidInCapitalCents?: number;
  }): Promise<CitPreviewResult> {
    const fy = opts.fiscalYear;
    const periodFrom = `${fy}-01-01`;
    const halfYearEnd = `${fy}-06-30`;
    const fullYearEnd = `${fy}-12-31`;
    const periodTo = opts.halfYear ? halfYearEnd : fullYearEnd;

    const pl = await this.financials.profitLoss({
      from: periodFrom,
      to: periodTo,
    });

    const revenue = pl.revenue.totalCents;
    const expense = pl.expense.totalCents;
    const taxable = pl.netIncomeCents;

    // For PND.51: annualised revenue = H1 × 2; for PND.50: actual.
    const annualisedRevenue = opts.halfYear ? revenue * 2 : revenue;

    // Default to ฿1M paid-in if caller didn't supply — keeps SME path realistic.
    const paidInCapital = opts.paidInCapitalCents ?? 100_000_000;

    const calcInput: CitCalcInput = opts.halfYear
      ? // PND.51: project H1 forward, halve final tax (per §67 estimate convention)
        {
          taxableIncomeCents: taxable * 2,
          paidInCapitalCents: paidInCapital,
          annualRevenueCents: annualisedRevenue,
        }
      : {
          taxableIncomeCents: taxable,
          paidInCapitalCents: paidInCapital,
          annualRevenueCents: annualisedRevenue,
        };

    const fullCalc = computeCit(calcInput);
    const taxDue = opts.halfYear
      ? Math.round(fullCalc.taxDueCents / 2)
      : fullCalc.taxDueCents;

    // WHT receivable balance (1157) over the period — only material on PND.50.
    let whtCredits = 0;
    if (!opts.halfYear) {
      const whtRows = await this.db
        .select({
          dr: sql<number>`coalesce(sum(${journalEntryLines.debitCents}), 0)::bigint`,
          cr: sql<number>`coalesce(sum(${journalEntryLines.creditCents}), 0)::bigint`,
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
            eq(journalEntryLines.accountCode, '1157'),
          ),
        );
      whtCredits = Number(whtRows[0]?.dr ?? 0) - Number(whtRows[0]?.cr ?? 0);
    }

    // Advance paid: PND.51 filing for the same year, if it exists.
    let advancePaid = 0;
    if (!opts.halfYear) {
      const prior = await this.db
        .select({ taxDue: citFilings.taxDueCents })
        .from(citFilings)
        .where(and(eq(citFilings.fiscalYear, fy), eq(citFilings.halfYear, true)))
        .limit(1);
      advancePaid = prior[0] ? Number(prior[0].taxDue) : 0;
    }

    const netPayable = taxDue - whtCredits - advancePaid;

    // Surface this period's filing if it exists.
    const existing = await this.db
      .select()
      .from(citFilings)
      .where(and(eq(citFilings.fiscalYear, fy), eq(citFilings.halfYear, opts.halfYear)))
      .limit(1);

    const warnings: string[] = [];
    if (taxable < 0) {
      warnings.push('Loss year — taxable income is negative. Tax due is 0; carry forward up to 5 years.');
    }
    if (calcInput.annualRevenueCents > 3_000_000_000 && fullCalc.rateBracket === 'flat20') {
      warnings.push('Annual revenue exceeds ฿30M — non-SME flat 20% rate applied.');
    }
    if (paidInCapital > 500_000_000) {
      warnings.push('Paid-in capital exceeds ฿5M — non-SME flat 20% rate applied.');
    }

    return {
      fiscalYear: fy,
      halfYear: opts.halfYear,
      periodFrom,
      periodTo,
      revenueCents: revenue,
      expenseCents: expense,
      taxableIncomeCents: taxable,
      paidInCapitalCents: paidInCapital,
      annualisedRevenueCents: annualisedRevenue,
      taxDueCents: taxDue,
      rateBracket: fullCalc.rateBracket,
      breakdown: fullCalc.breakdown,
      whtCreditsCents: whtCredits,
      advancePaidCents: advancePaid,
      netPayableCents: netPayable,
      alreadyFiled: existing.length > 0,
      filing: existing[0]
        ? {
            id: existing[0].id,
            filedAt: (existing[0].filedAt as Date).toISOString(),
            filedBy: existing[0].filedBy,
            rdFilingReference: existing[0].rdFilingReference,
            notes: existing[0].notes,
            netPayableCents: Number(existing[0].netPayableCents),
          }
        : null,
      warnings,
    };
  }

  /**
   * File the CIT for a (year, halfYear) period. Persists the snapshot in
   * `cit_filings`, posts a CIT-expense journal entry (Dr 9110 / Cr 2204
   * CIT payable, with WHT credits + advance offsets), and locks the
   * period from being re-filed.
   */
  async file(opts: {
    fiscalYear: number;
    halfYear: boolean;
    paidInCapitalCents?: number;
    filedBy?: string | null;
    rdFilingReference?: string;
    notes?: string;
  }) {
    const preview = await this.preview(opts);
    if (preview.alreadyFiled) {
      throw new ConflictException(
        `CIT already filed for ${opts.fiscalYear}${opts.halfYear ? ' H1' : ''}`,
      );
    }
    if (preview.taxDueCents <= 0 && preview.taxableIncomeCents <= 0) {
      throw new BadRequestException(
        'Cannot file CIT for a loss / zero-tax period — record the carry-forward separately',
      );
    }

    // Need 2220 (Income tax payable) — verify or surface a clear error.
    const acct = await this.db
      .select({ code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.code, '2220'))
      .limit(1);
    if (acct.length === 0) {
      throw new NotFoundException(
        '2220 Income tax payable account missing from CoA — add it before filing',
      );
    }

    // JE: Dr 9110 (expense) for full taxDue
    //     Cr 1157 (WHT receivable) for whtCredits used
    //     Cr 2220 (Income tax payable) for the residual = taxDue − whtCredits
    // (PND.51 advance paid lives outside this entry — it's already in 1157
    // when the customer withholds, so by the time we settle on PND.50 the
    // wht_credits term covers both withholdings and prepaid.)
    const lines: Array<{
      accountCode: string;
      accountName: string;
      debitCents: number;
      creditCents: number;
    }> = [
      {
        accountCode: '9110',
        accountName: 'Corporate income tax',
        debitCents: preview.taxDueCents,
        creditCents: 0,
      },
    ];
    if (preview.whtCreditsCents > 0) {
      lines.push({
        accountCode: '1157',
        accountName: 'WHT receivable (offset against CIT)',
        debitCents: 0,
        creditCents: preview.whtCreditsCents,
      });
    }
    const cashOut = preview.taxDueCents - preview.whtCreditsCents;
    if (cashOut > 0) {
      lines.push({
        accountCode: '2220',
        accountName: 'Income tax payable',
        debitCents: 0,
        creditCents: cashOut,
      });
    } else if (cashOut < 0) {
      // WHT > tax due → flip sign to debit (the payable becomes a receivable
      // until we either request a refund or net against next year's CIT).
      lines.push({
        accountCode: '2220',
        accountName: 'Income tax payable (refund position)',
        debitCents: -cashOut,
        creditCents: 0,
      });
    }

    const entry = JournalEntry.create({
      date: preview.periodTo,
      description: `CIT ${opts.halfYear ? 'PND.51' : 'PND.50'} for FY${opts.fiscalYear}`,
      reference: `CIT-${opts.fiscalYear}${opts.halfYear ? '-H1' : ''}`,
      sourceModule: 'cit',
      sourceId: `${opts.fiscalYear}${opts.halfYear ? '-H1' : ''}`,
      currency: 'THB',
      lines,
    });

    // posted_by is a uuid column (system actor), filed_by is the audit trail
    // attribution (free-form text). They're separate concepts — don't conflate.
    const je = await this.journals.insert(entry, { autoPost: true });

    const [row] = await this.db
      .insert(citFilings)
      .values({
        fiscalYear: opts.fiscalYear,
        halfYear: opts.halfYear,
        taxableIncomeCents: preview.taxableIncomeCents,
        taxDueCents: preview.taxDueCents,
        whtCreditsCents: preview.whtCreditsCents,
        advancePaidCents: preview.advancePaidCents,
        netPayableCents: preview.netPayableCents,
        rateBracket: preview.rateBracket,
        filedBy: opts.filedBy ?? null,
        rdFilingReference: opts.rdFilingReference ?? null,
        notes: opts.notes ?? null,
        closingJournalId: je.id,
      })
      .returning();

    return {
      filingId: row.id,
      journalEntryId: je.id,
      ...preview,
      alreadyFiled: true,
      filing: {
        id: row.id,
        filedAt: (row.filedAt as Date).toISOString(),
        filedBy: row.filedBy,
        rdFilingReference: row.rdFilingReference,
        notes: row.notes,
        netPayableCents: Number(row.netPayableCents),
      },
    };
  }

  async list(opts: { fiscalYear?: number } = {}) {
    const where = opts.fiscalYear ? eq(citFilings.fiscalYear, opts.fiscalYear) : undefined;
    const rows = await this.db
      .select()
      .from(citFilings)
      .where(where as any)
      .orderBy(sql`${citFilings.fiscalYear} DESC, ${citFilings.halfYear} DESC`);
    return rows.map((r) => ({
      id: r.id,
      fiscalYear: r.fiscalYear,
      halfYear: r.halfYear,
      taxableIncomeCents: Number(r.taxableIncomeCents),
      taxDueCents: Number(r.taxDueCents),
      whtCreditsCents: Number(r.whtCreditsCents),
      advancePaidCents: Number(r.advancePaidCents),
      netPayableCents: Number(r.netPayableCents),
      rateBracket: r.rateBracket,
      filedAt: (r.filedAt as Date).toISOString(),
      filedBy: r.filedBy,
      rdFilingReference: r.rdFilingReference,
      notes: r.notes,
    }));
  }
}
