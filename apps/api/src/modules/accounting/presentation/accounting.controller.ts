import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, asc } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { chartOfAccounts, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../infrastructure/journal.repository';
import { AccountingService, type ManualJournalInput } from '../application/services/accounting.service';
import { FinancialStatementsService } from '../application/financial-statements.service';
import { PosJournalBackfillService } from '../application/pos-journal-backfill.service';
import {
  FixedAssetsService,
  type CreateFixedAssetInput,
  type DisposeFixedAssetInput,
} from '../application/fixed-assets.service';
import { Roles } from '../../auth/jwt-auth.guard';

/**
 * All routes require an authenticated user (global JwtAuthGuard).
 *
 * Role policy:
 *   chart-of-accounts (GET) — anyone authenticated (read-only metadata).
 *   journal-entries (GET / POST / void) — accountant or admin.
 *   trial-balance (GET) — accountant or admin.
 *   backfill — admin only (replays historical journals; one-shot operation).
 */
@Controller('api/accounting')
export class AccountingController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
    private readonly accounting: AccountingService,
    private readonly financials: FinancialStatementsService,
    private readonly backfill: PosJournalBackfillService,
    private readonly fixedAssets: FixedAssetsService,
  ) {}

  @Get('chart-of-accounts')
  async chart() {
    const rows = await this.db
      .select()
      .from(chartOfAccounts)
      .orderBy(asc(chartOfAccounts.code));
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      nameTh: r.nameTh,
      nameEn: r.nameEn,
      type: r.type,
      parentCode: r.parentCode,
      isActive: r.isActive,
      normalBalance: r.normalBalance,
      isCashAccount: r.isCashAccount,
    }));
  }

  /**
   * Update editable fields on a chart-of-accounts row. Admin-only because
   * flipping `is_cash_account` lights up an account in dropdowns and the
   * Cash Flow Statement; flipping `is_active` makes it disappear from
   * journal-entry pickers. The seeded structural fields (type, parent,
   * normalBalance) are intentionally NOT editable here — those would
   * change accounting semantics, not user preferences.
   */
  @Roles('admin')
  @Patch('chart-of-accounts/:code')
  async updateAccount(
    @Param('code') code: string,
    @Body()
    body: {
      isCashAccount?: boolean;
      isActive?: boolean;
      nameTh?: string;
      nameEn?: string;
    },
  ) {
    const patch: Record<string, unknown> = {};
    if (typeof body.isCashAccount === 'boolean') patch.isCashAccount = body.isCashAccount;
    if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
    if (typeof body.nameTh === 'string' && body.nameTh.trim()) patch.nameTh = body.nameTh.trim();
    if (typeof body.nameEn === 'string' && body.nameEn.trim()) patch.nameEn = body.nameEn.trim();
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'no updatable fields supplied (allowed: isCashAccount, isActive, nameTh, nameEn)',
      );
    }
    const rows = await this.db
      .update(chartOfAccounts)
      .set(patch as any)
      .where(eq(chartOfAccounts.code, code))
      .returning();
    if (rows.length === 0) {
      throw new NotFoundException(`account ${code} not found`);
    }
    return {
      code: rows[0].code,
      name: rows[0].name,
      nameTh: rows[0].nameTh,
      nameEn: rows[0].nameEn,
      type: rows[0].type,
      parentCode: rows[0].parentCode,
      isActive: rows[0].isActive,
      normalBalance: rows[0].normalBalance,
      isCashAccount: rows[0].isCashAccount,
    };
  }

  /**
   * Returns the active cash + cash-equivalent accounts. Drives every
   * cash-account dropdown (POS receipts, AP/AR payments, bank rec) and the
   * Cash Flow Statement's cash + cash equivalents line.
   */
  @Get('chart-of-accounts/cash')
  async cashAccounts() {
    const rows = await this.db
      .select({
        code: chartOfAccounts.code,
        nameTh: chartOfAccounts.nameTh,
        nameEn: chartOfAccounts.nameEn,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.isCashAccount, true),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .orderBy(asc(chartOfAccounts.code));
    return rows;
  }

  @Get('journal-entries')
  @Roles('admin', 'accountant')
  async list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: 'draft' | 'posted' | 'voided',
    @Query('source') source?: string,
    @Query('limit') limit?: string,
  ) {
    return this.journals.list({
      from,
      to,
      status,
      sourceModule: source,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('journal-entries/:id')
  @Roles('admin', 'accountant')
  async get(@Param('id') id: string) {
    const entry = await this.journals.findWithLines(id);
    if (!entry) throw new NotFoundException(`Journal entry ${id} not found`);
    return entry;
  }

  @Post('journal-entries')
  @Roles('admin', 'accountant')
  async create(@Body() body: ManualJournalInput) {
    if (!body?.date || !body?.description || !Array.isArray(body.lines)) {
      throw new BadRequestException(
        'date, description and lines are required',
      );
    }
    try {
      return await this.accounting.postManual(body);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'invalid journal entry');
    }
  }

  @Post('journal-entries/:id/void')
  @Roles('admin', 'accountant')
  async void(@Param('id') id: string, @Body() body: { reason?: string }) {
    if (!body?.reason || body.reason.trim().length < 3) {
      throw new BadRequestException('reason is required (≥3 chars)');
    }
    try {
      return await this.accounting.voidEntry(id, body.reason);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'cannot void');
    }
  }

  /**
   * Replay missing POS sales + COGS journals.
   * Closes the gap surfaced by /api/reports/pp30/reconcile when historical
   * orders pre-date the live event handlers (Phase 4 batches 1-2). Idempotent:
   * skips orders that already have a posted entry. Pass `?dryRun=1` to see
   * candidate counts without writing.
   */
  @Post('backfill/pos-journals')
  @Roles('admin')
  async runBackfill(@Query('dryRun') dryRun?: string) {
    return this.backfill.run({ dryRun: dryRun === '1' || dryRun === 'true' });
  }

  /**
   * Trial balance as of a date. With no `asOf` supplied, returns
   * today (server clock).
   */
  @Get('trial-balance')
  @Roles('admin', 'accountant')
  async trialBalance(@Query('asOf') asOf?: string) {
    const date = asOf ?? new Date().toISOString().slice(0, 10);
    const rows = await this.journals.trialBalance(date);
    const totalDebit = rows.reduce((s, r) => s + r.debitCents, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditCents, 0);
    return {
      asOfDate: date,
      rows,
      totals: {
        debitCents: totalDebit,
        creditCents: totalCredit,
        deltaCents: totalDebit - totalCredit, // must be zero
      },
    };
  }

  /**
   * Profit & Loss for [from, to] inclusive. Defaults to MTD when no params.
   * Net Income = revenue (credit-balance) − expense (debit-balance).
   */
  @Get('profit-loss')
  @Roles('admin', 'accountant')
  profitLoss(@Query('from') from?: string, @Query('to') to?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    return this.financials.profitLoss({ from: from ?? monthStart, to: to ?? today });
  }

  /**
   * Balance Sheet at a point in time. Equity is augmented with the period-
   * to-date Net Income from `fiscalYearStart` (defaults to Jan 1 of asOf
   * year) so the BS always balances against the Trial Balance.
   */
  @Get('balance-sheet')
  @Roles('admin', 'accountant')
  balanceSheet(
    @Query('asOf') asOf?: string,
    @Query('fiscalYearStart') fiscalYearStart?: string,
  ) {
    return this.financials.balanceSheet({
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
      fiscalYearStart,
    });
  }

  /**
   * Cash Flow for [from, to] inclusive. Indirect method, categorised by
   * each JE's `source_module`. Verifies against direct delta on cash
   * accounts (1110/1120/1130).
   */
  @Get('cash-flow')
  @Roles('admin', 'accountant')
  cashFlow(@Query('from') from?: string, @Query('to') to?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    return this.financials.cashFlow({ from: from ?? monthStart, to: to ?? today });
  }

  // ─── Fixed Assets ──────────────────────────────────────────────────────

  @Get('fixed-assets')
  @Roles('admin', 'accountant')
  listAssets(@Query('status') status?: 'active' | 'disposed' | 'retired') {
    return this.fixedAssets.list({ status });
  }

  @Get('fixed-assets/:id')
  @Roles('admin', 'accountant')
  oneAsset(@Param('id') id: string) {
    return this.fixedAssets.findOne(id);
  }

  /** Full straight-line schedule for the asset — pure preview, no DB writes. */
  @Get('fixed-assets/:id/schedule')
  @Roles('admin', 'accountant')
  assetSchedule(@Param('id') id: string) {
    return this.fixedAssets.schedule(id);
  }

  @Post('fixed-assets')
  @Roles('admin')
  createAsset(@Body() body: CreateFixedAssetInput) {
    return this.fixedAssets.create(body);
  }

  /**
   * Mark active asset as disposed/retired. Generates the closing JE that
   * zeros the cost + accumulated depreciation and books any gain/loss.
   */
  @Post('fixed-assets/:id/dispose')
  @Roles('admin')
  disposeAsset(@Param('id') id: string, @Body() body: DisposeFixedAssetInput) {
    return this.fixedAssets.dispose(id, body);
  }

  /**
   * Run depreciation for a given (year, month). Idempotent — assets that
   * already have an entry for that period are skipped. Posts one JE per
   * eligible asset (Dr expense / Cr accumulated depreciation).
   */
  @Post('fixed-assets/run-depreciation')
  @Roles('admin')
  runDepreciation(@Body() body: { year: number; month: number; postedBy?: string }) {
    if (!Number.isInteger(body.year) || body.year < 2000 || body.year > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(body.month) || body.month < 1 || body.month > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    return this.fixedAssets.runMonthlyDepreciation(body.year, body.month, {
      postedBy: body.postedBy,
    });
  }
}
