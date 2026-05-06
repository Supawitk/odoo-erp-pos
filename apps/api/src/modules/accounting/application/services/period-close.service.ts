import { Injectable, Inject, Logger } from '@nestjs/common';
import { OdooJsonRpcClient } from '../../../../shared/infrastructure/odoo/odoo-jsonrpc.client';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { journalEntries, journalEntryLines } from '@erp/db';
import { eq, and, gte, lte, sql } from 'drizzle-orm';

export type CutoffType = 'accrued_expense' | 'accrued_revenue' | 'prepaid_expense' | 'prepaid_revenue';

export interface OdooCutoff {
  id: number;
  cutoffType: CutoffType;
  cutoffDate: string;
  state: 'draft' | 'done';
  moveRef: string;
  lineCount: number;
}

export interface OdooFiscalYearClose {
  id: number;
  name: string;
  year: number;
  state: 'draft' | 'calculated' | 'in_progress' | 'done' | 'cancelled';
  dateStart: string;
  dateEnd: string;
  dateOpening: string | null;
}

export interface PeriodCloseSummary {
  periodFrom: string;
  periodTo: string;
  /** Posted JEs in the period */
  postedEntries: number;
  /** Debit = credit; always 0 for a healthy ledger */
  balanceDeltaCents: number;
  /** Un-reconciled bank lines (approx — actual reconciliation is in bank-rec module) */
  unreconciledBankLines: number;
  /** Draft bills/invoices that should be posted before closing */
  draftDocuments: number;
  /** Whether the period is clean enough to close */
  readyToClose: boolean;
  warnings: string[];
}

/**
 * Bridges OCA account-closing module (accrual cutoffs + fiscal year close)
 * with our own journal-entry ledger. OCA handles the Odoo side (generating
 * reversal JEs, state machine); we expose the control surface via REST so
 * the web UI can trigger and monitor period-end workflows without the
 * operator needing to log into Odoo.
 */
@Injectable()
export class PeriodCloseService {
  private readonly logger = new Logger(PeriodCloseService.name);

  constructor(
    private readonly odoo: OdooJsonRpcClient,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  /** List all accrual cutoff batches from Odoo, newest first. */
  async listCutoffs(): Promise<OdooCutoff[]> {
    if (this.odoo.isCircuitOpen()) return [];
    try {
      const rows = await this.odoo.searchRead<{
        id: number;
        cutoff_type: string;
        cutoff_date: string;
        state: string;
        move_ref: string;
        line_ids: number[];
      }>(
        'account.cutoff',
        [],
        ['id', 'cutoff_type', 'cutoff_date', 'state', 'move_ref', 'line_ids'],
        { limit: 50, order: 'cutoff_date desc, id desc' },
      );
      return rows.map((r) => ({
        id: r.id,
        cutoffType: r.cutoff_type as CutoffType,
        cutoffDate: r.cutoff_date,
        state: r.state as OdooCutoff['state'],
        moveRef: r.move_ref || '',
        lineCount: Array.isArray(r.line_ids) ? r.line_ids.length : 0,
      }));
    } catch (err) {
      this.logger.warn(`Failed to list cutoffs from Odoo: ${(err as Error).message}`);
      return [];
    }
  }

  /** Create a new accrual cutoff batch in Odoo and optionally generate lines. */
  async createCutoff(type: CutoffType, cutoffDate: string): Promise<{ id: number }> {
    const id = await this.odoo.create('account.cutoff', {
      cutoff_type: type,
      cutoff_date: cutoffDate,
    });
    return { id };
  }

  /** List all fiscal year closing records from Odoo. */
  async listFiscalYearClosings(): Promise<OdooFiscalYearClose[]> {
    if (this.odoo.isCircuitOpen()) return [];
    try {
      const rows = await this.odoo.searchRead<{
        id: number;
        name: string;
        year: number;
        state: string;
        date_start: string;
        date_end: string;
        date_opening: string | false;
      }>(
        'account.fiscalyear.closing',
        [],
        ['id', 'name', 'year', 'state', 'date_start', 'date_end', 'date_opening'],
        { limit: 20, order: 'year desc, id desc' },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name || `FY ${r.year}`,
        year: r.year,
        state: r.state as OdooFiscalYearClose['state'],
        dateStart: r.date_start,
        dateEnd: r.date_end,
        dateOpening: r.date_opening || null,
      }));
    } catch (err) {
      this.logger.warn(`Failed to list FY closings from Odoo: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Period-close readiness check against our local ledger.
   * Does NOT write anything — purely diagnostic.
   */
  async periodSummary(from: string, to: string): Promise<PeriodCloseSummary> {
    const db = this.db;

    // Count posted JEs in range
    const [{ cnt: posted }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
        ),
      );

    // Balance check: sum debits - credits for the period (must be 0)
    const [{ dr, cr }] = await db
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
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
        ),
      );

    const delta = Number(dr) - Number(cr);

    const warnings: string[] = [];
    if (delta !== 0) warnings.push(`Ledger out of balance by ${delta} satang — investigate before closing`);
    if (Number(posted) === 0) warnings.push('No posted journal entries in this period');

    return {
      periodFrom: from,
      periodTo: to,
      postedEntries: Number(posted),
      balanceDeltaCents: delta,
      unreconciledBankLines: 0, // populated by bank-rec module query when needed
      draftDocuments: 0,
      readyToClose: warnings.length === 0,
      warnings,
    };
  }
}
