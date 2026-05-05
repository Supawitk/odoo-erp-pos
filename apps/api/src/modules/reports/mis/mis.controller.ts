import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { Roles } from '../../auth/jwt-auth.guard';
import { MisService } from './mis.service';
import type { MisListEntry, MisReport } from './mis.types';

/**
 * MIS reports — TFRS-format Balance Sheet, Profit & Loss, Trial Balance
 * driven by OCA/mis-builder + l10n_th_mis_report templates pulled from
 * Odoo, computed against our own custom.journal_entry_lines.
 *
 * Auth: global JwtAuthGuard. Financial reports gated to admin + accountant.
 */
@Controller('api/reports/mis')
@Roles('admin', 'accountant')
export class MisController {
  constructor(private readonly mis: MisService) {}

  @Get('templates')
  async templates(): Promise<MisListEntry[]> {
    return this.mis.listTemplates();
  }

  /**
   * GET /api/reports/mis/:templateId?from=YYYY-MM-DD&to=YYYY-MM-DD&compare=1
   *
   * `compare=1` adds an automatic prior-period comparison column. Period
   * length matches the current window (e.g. April 2026 vs March 2026 if
   * current is one month).
   */
  @Get(':templateId')
  async compute(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('compare') compare?: string,
  ): Promise<MisReport> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Default: current month start → today.
    const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1);
    const fromDate = from ? parseDate(from) : defaultFrom;
    const toDate = to ? parseDate(to) : today;

    let compareWith: { from: Date; to: Date } | undefined;
    if (compare === '1' || compare === 'true') {
      const span = toDate.getTime() - fromDate.getTime();
      // Mirror window length immediately preceding the current window.
      const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
      const prevFrom = new Date(prevTo.getTime() - span);
      compareWith = { from: prevFrom, to: prevTo };
    }

    return this.mis.compute(templateId, {
      from: fromDate,
      to: toDate,
      compareWith,
    });
  }
}

function parseDate(s: string): Date {
  // Accept YYYY-MM-DD; reject anything else to keep the URL surface tight.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date format ${s} (expected YYYY-MM-DD)`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date ${s}`);
  }
  return d;
}
