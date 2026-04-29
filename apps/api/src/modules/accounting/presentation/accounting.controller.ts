import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { chartOfAccounts, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../infrastructure/journal.repository';
import { AccountingService, type ManualJournalInput } from '../application/services/accounting.service';

@Controller('api/accounting')
export class AccountingController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
    private readonly accounting: AccountingService,
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
    }));
  }

  @Get('journal-entries')
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
  async get(@Param('id') id: string) {
    const entry = await this.journals.findWithLines(id);
    if (!entry) throw new NotFoundException(`Journal entry ${id} not found`);
    return entry;
  }

  @Post('journal-entries')
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
   * Trial balance as of a date. With no `asOf` supplied, returns
   * today (server clock).
   */
  @Get('trial-balance')
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
}
