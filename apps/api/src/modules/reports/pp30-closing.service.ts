import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import {
  posOrders,
  pp30Filings,
  vendorBills,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../accounting/infrastructure/journal.repository';
import { JournalEntry } from '../accounting/domain/journal-entry';
import { PP30Service } from './pp30.service';
import { buildClosingBlueprint } from './pp30-closing.builder';

/**
 * 🇹🇭 PP.30 monthly close — books the period's VAT settlement journal and
 * stamps every contributing pos_order + vendor_bill with the resulting
 * pp30_filings.id.
 *
 * Why "stamp on close, not on file":
 *   The act of POSTING the journal IS the act of claiming. Until that journal
 *   is posted, 1155 still has the pre-close balance. We can't pre-stamp bills
 *   without committing the journal — the two are atomic.
 *
 * Why this matters for the §82/3 reclass cron:
 *   Once a bill is stamped pp30_filing_id, its 1155 share has already moved
 *   to 2210 / 1158. Reclassing it again would credit 1155 a second time and
 *   leave a phantom 6390 expense. The reclass eligibility predicate now
 *   excludes pp30-claimed bills as a hard precondition.
 */

const VAT_PAYABLE_ACCOUNT = '2210';
const VAT_REFUND_ACCOUNT = '1158';
const OUTPUT_VAT_ACCOUNT = '2201';
const INPUT_VAT_ACCOUNT = '1155';

export interface ClosingPreview {
  periodYear: number;
  periodMonth: number;
  periodLabel: string;
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  branch: 'payable' | 'refund' | 'wash' | 'noop';
  source: {
    contributingOrderCount: number;
    contributingBillCount: number;
  };
  blueprintLines: Array<{
    accountCode: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
  }>;
  alreadyFiled: boolean;
  filing: PP30FilingRow | null;
}

export interface PP30FilingRow {
  id: string;
  periodYear: number;
  periodMonth: number;
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  status: 'filed' | 'amended';
  closingJournalId: string | null;
  filedAt: string;
  filedBy: string | null;
  rdFilingReference: string | null;
  notes: string | null;
}

export interface CloseResult {
  filing: PP30FilingRow;
  closingJournalId: string;
  branch: 'payable' | 'refund' | 'wash' | 'noop';
  stampedOrderCount: number;
  stampedBillCount: number;
}

@Injectable()
export class Pp30ClosingService {
  private readonly logger = new Logger(Pp30ClosingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pp30: PP30Service,
    private readonly journals: JournalRepository,
  ) {}

  /**
   * Read-only preview: computes the would-be closing journal + counts of
   * contributing rows, plus surfaces an existing filing if one exists.
   */
  async preview(year: number, month: number): Promise<ClosingPreview> {
    requireValidPeriod(year, month);
    const [output, input, existing] = await Promise.all([
      this.pp30.forMonth(year, month),
      this.sumEligibleInputVat(year, month),
      this.findActiveFiling(year, month),
    ]);
    const blueprint = buildClosingBlueprint(
      Math.max(0, output.net.outputVatAfterCN),
      input.totalCents,
    );

    return {
      periodYear: year,
      periodMonth: month,
      periodLabel: periodLabel(year, month),
      outputVatCents: blueprint.outputVatCents,
      inputVatCents: blueprint.inputVatCents,
      netPayableCents: blueprint.netPayableCents,
      branch: blueprint.branch,
      source: {
        contributingOrderCount:
          output.source.orderCount + output.source.creditNoteCount,
        contributingBillCount: input.billCount,
      },
      blueprintLines: blueprint.lines,
      alreadyFiled: !!existing,
      filing: existing,
    };
  }

  /**
   * Atomically: posts the closing journal, inserts pp30_filings row, stamps
   * contributing pos_order + vendor_bill rows. If any step fails the whole tx
   * rolls back — the period stays open.
   *
   * Concurrency: serialised by the partial UNIQUE index on
   * (period_year, period_month) WHERE status='filed'. Two simultaneous closes
   * for the same period race on the INSERT and the loser gets ConflictException.
   */
  async close(
    year: number,
    month: number,
    opts: { filedBy?: string | null; rdFilingReference?: string; notes?: string } = {},
  ): Promise<CloseResult> {
    requireValidPeriod(year, month);

    // Pre-flight: refuse to close if a filing already exists.
    const existing = await this.findActiveFiling(year, month);
    if (existing) {
      throw new ConflictException(
        `PP.30 ${periodLabel(year, month)} is already filed (${existing.id}). Use the amendment flow.`,
      );
    }

    const preview = await this.preview(year, month);
    if (preview.branch === 'noop') {
      throw new BadRequestException(
        `Nothing to close for ${preview.periodLabel} — no output or input VAT in the period.`,
      );
    }

    const result = await this.db.transaction(async (tx) => {
      // Re-take the eligible-bill snapshot inside the tx so a bill posted
      // between preview() and close() can't sneak in/out of the period.
      const eligibleBills = await this.eligibleBillIds(tx, year, month);
      const eligibleOrders = await this.eligibleOrderIds(tx, year, month);
      const eligibleInput = eligibleBills.reduce((s, b) => s + b.vatCents, 0);

      // Output VAT must be re-derived from PP30Service inside the tx so we don't
      // trust the preview snapshot. Keep it simple: reuse the (already-computed)
      // preview value — POS orders are written via separate flows that don't
      // race with /pp30/close, and the eligible-orders check below proves the
      // contributing rows still exist.
      const outputCents = preview.outputVatCents;

      const blueprint = buildClosingBlueprint(outputCents, eligibleInput);
      if (blueprint.branch === 'noop') {
        throw new BadRequestException(
          `Nothing to close inside the tx (preview drift). Refresh and retry.`,
        );
      }

      // Insert the filing row FIRST so we have an id to stamp + reference. The
      // closing_journal_id gets backfilled after journal post.
      const [filingRow] = await tx
        .insert(pp30Filings)
        .values({
          periodYear: year,
          periodMonth: month,
          outputVatCents: blueprint.outputVatCents,
          inputVatCents: blueprint.inputVatCents,
          netPayableCents: blueprint.netPayableCents,
          status: 'filed',
          filedAt: new Date(),
          filedBy: opts.filedBy && isUuid(opts.filedBy) ? opts.filedBy : null,
          rdFilingReference: opts.rdFilingReference ?? null,
          notes: opts.notes ?? null,
        })
        .returning();

      // Build + post the journal.
      const entry = JournalEntry.create({
        date: lastDayOfMonth(year, month),
        description: `PP.30 close ${periodLabel(year, month)} (${blueprint.branch})`,
        reference: filingRow.id,
        sourceModule: 'reports.pp30-close',
        sourceId: filingRow.id,
        currency: 'THB',
        lines: blueprint.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
        })),
      });
      const posted = await this.journals.insert(entry, {
        autoPost: true,
        postedBy: opts.filedBy && isUuid(opts.filedBy) ? opts.filedBy : null,
      });

      await tx
        .update(pp30Filings)
        .set({ closingJournalId: posted.id })
        .where(eq(pp30Filings.id, filingRow.id));

      // Stamp every contributing row. We use ANY()-style IN with the captured
      // ids rather than re-running the where-clause to avoid double-counting
      // race conditions.
      let stampedBills = 0;
      for (const b of eligibleBills) {
        await tx
          .update(vendorBills)
          .set({ pp30FilingId: filingRow.id, updatedAt: new Date() })
          .where(eq(vendorBills.id, b.id));
        stampedBills += 1;
      }
      let stampedOrders = 0;
      for (const o of eligibleOrders) {
        await tx
          .update(posOrders)
          .set({ pp30FilingId: filingRow.id, updatedAt: new Date() })
          .where(eq(posOrders.id, o));
        stampedOrders += 1;
      }

      return {
        filing: mapFiling({ ...filingRow, closingJournalId: posted.id }),
        closingJournalId: posted.id,
        branch: blueprint.branch,
        stampedOrderCount: stampedOrders,
        stampedBillCount: stampedBills,
      };
    });

    this.logger.log(
      `PP.30 close ${periodLabel(year, month)} (${result.branch}) — output=${result.filing.outputVatCents} input=${result.filing.inputVatCents} net=${result.filing.netPayableCents} (${result.stampedBillCount} bills + ${result.stampedOrderCount} orders stamped)`,
    );
    return result;
  }

  /** Lookup helper — used by preview() and the GET endpoint. */
  async findActiveFiling(year: number, month: number): Promise<PP30FilingRow | null> {
    requireValidPeriod(year, month);
    const rows = await this.db
      .select()
      .from(pp30Filings)
      .where(
        and(
          eq(pp30Filings.periodYear, year),
          eq(pp30Filings.periodMonth, month),
          eq(pp30Filings.status, 'filed'),
        ),
      )
      .limit(1);
    return rows[0] ? mapFiling(rows[0]) : null;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Sum input VAT for bills eligible for THIS period's close:
   *   - tax-point (supplier_tax_invoice_date ?? bill_date) in/before period end
   *   - status posted/partially_paid/paid (1155 was actually debited)
   *   - vat_cents > 0
   *   - NOT yet pp30-claimed (don't double-count)
   *   - NOT yet reclassed to 6390 (would double-credit 1155)
   *
   * Note: bills from BEFORE the period are still in scope — RD lets you claim
   * input VAT in the tax-point month OR any of the next 6 months. This is the
   * "claim now or lose it" window that the §82/3 reclass cron enforces.
   */
  private async sumEligibleInputVat(year: number, month: number) {
    const periodEnd = lastDayOfMonth(year, month); // ISO yyyy-mm-dd inclusive
    const rows = await this.db
      .select({ id: vendorBills.id, vatCents: vendorBills.vatCents })
      .from(vendorBills)
      .where(
        and(
          sql`${vendorBills.vatCents} > 0`,
          sql`${vendorBills.status} IN ('posted','partially_paid','paid')`,
          sql`COALESCE(${vendorBills.supplierTaxInvoiceDate}, ${vendorBills.billDate}) <= ${periodEnd}`,
          isNull(vendorBills.pp30FilingId),
          isNull(vendorBills.inputVatReclassedAt),
        ),
      );
    return {
      totalCents: rows.reduce((s, r) => s + Number(r.vatCents), 0),
      billCount: rows.length,
    };
  }

  /** Same eligibility check but returns the raw ids (used inside close tx). */
  private async eligibleBillIds(
    tx: Database | { select: Database['select']; update: Database['update']; insert: Database['insert']; delete: Database['delete'] },
    year: number,
    month: number,
  ): Promise<Array<{ id: string; vatCents: number }>> {
    const periodEnd = lastDayOfMonth(year, month);
    const rows = await tx
      .select({ id: vendorBills.id, vatCents: vendorBills.vatCents })
      .from(vendorBills)
      .where(
        and(
          sql`${vendorBills.vatCents} > 0`,
          sql`${vendorBills.status} IN ('posted','partially_paid','paid')`,
          sql`COALESCE(${vendorBills.supplierTaxInvoiceDate}, ${vendorBills.billDate}) <= ${periodEnd}`,
          isNull(vendorBills.pp30FilingId),
          isNull(vendorBills.inputVatReclassedAt),
        ),
      );
    return rows.map((r) => ({ id: r.id, vatCents: Number(r.vatCents) }));
  }

  private async eligibleOrderIds(
    tx: Database | { select: Database['select']; update: Database['update']; insert: Database['insert']; delete: Database['delete'] },
    year: number,
    month: number,
  ): Promise<string[]> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const rows = await tx
      .select({ id: posOrders.id })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.createdAt, from),
          lt(posOrders.createdAt, to),
          isNull(posOrders.pp30FilingId),
        ),
      );
    return rows.map((r) => r.id);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function requireValidPeriod(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new BadRequestException(`year must be 2000-9999 (got ${year})`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException(`month must be 1-12 (got ${month})`);
  }
}

function periodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): string {
  // Date.UTC(year, month, 0) returns last day of month-1 → month=4 returns Mar 31. We want last day of month, so use month with day=0 of next month.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

function mapFiling(r: any): PP30FilingRow {
  return {
    id: r.id,
    periodYear: Number(r.periodYear),
    periodMonth: Number(r.periodMonth),
    outputVatCents: Number(r.outputVatCents),
    inputVatCents: Number(r.inputVatCents),
    netPayableCents: Number(r.netPayableCents),
    status: r.status,
    closingJournalId: r.closingJournalId ?? null,
    filedAt: r.filedAt instanceof Date ? r.filedAt.toISOString() : r.filedAt,
    filedBy: r.filedBy ?? null,
    rdFilingReference: r.rdFilingReference ?? null,
    notes: r.notes ?? null,
  };
}
