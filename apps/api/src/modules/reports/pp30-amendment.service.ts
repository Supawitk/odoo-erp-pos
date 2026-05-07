import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { posOrders, pp30Filings, vendorBills, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../accounting/infrastructure/journal.repository';
import { JournalEntry } from '../accounting/domain/journal-entry';
import { PP30Service } from './pp30.service';
import { computeSurcharge } from './pp30-surcharge';
import { buildAmendmentBlueprint } from './pp30-amendment.builder';

/**
 * 🇹🇭 PP.30.2 amendment flow.
 *
 * When a merchant discovers they missed a sales invoice or vendor bill in a
 * previously-filed PP.30 period, they file a PP.30.2 amendment. The mechanics:
 *
 *   1. Recompute the period's full output + input VAT from current ledger state
 *      (NOT trusting pp30_filing_id stamps — fresh aggregate).
 *   2. Diff against the previous active filing → addOutputVat / addInputVat.
 *   3. If addNet > 0 (more VAT payable), compute §27 surcharge:
 *      surcharge = additionalVat × 1.5% × monthsLate (capped at 200%).
 *   4. In one transaction:
 *      a. Mark the previous 'filed' row as 'amended' (releases the partial
 *         UNIQUE constraint).
 *      b. Insert a new 'filed' row with originalFilingId, amendmentSequence,
 *         and the surcharge fields populated.
 *      c. Post the delta journal — moves only the additional output VAT out of
 *         2201 and the additional input VAT out of 1155, plus surcharge accrual
 *         (Dr 6390 / Cr 2210).
 *      d. Stamp the newly-eligible bills + orders (those that weren't included
 *         in the previous filing) with the new filing id, and re-stamp the old
 *         filing's contributing rows so pp30_filing_id always points at the
 *         currently-active filing for the period.
 *
 * Lineage preserved: the superseded row stays in pp30_filings with
 * status='amended', and amendmentSequence chains through (0 → 1 → 2 → ...).
 *
 * Concurrency: the partial UNIQUE on (period_year, period_month) WHERE
 * status='filed' guarantees exactly one active row per period at any time.
 * Two concurrent amends for the same period race on the INSERT — loser gets
 * ConflictException.
 */

const VAT_PAYABLE_ACCOUNT = '2210';
const VAT_REFUND_ACCOUNT = '1158';
const OUTPUT_VAT_ACCOUNT = '2201';
const INPUT_VAT_ACCOUNT = '1155';
const SURCHARGE_EXPENSE_ACCOUNT = '6390';

export interface AmendmentPreview {
  periodYear: number;
  periodMonth: number;
  periodLabel: string;
  /** The currently active 'filed' row that would be amended. */
  previous: PP30FilingSnapshot;
  /** Recomputed totals from current ledger state. */
  recomputed: {
    outputVatCents: number;
    inputVatCents: number;
    netPayableCents: number;
    contributingOrderCount: number;
    contributingBillCount: number;
  };
  delta: {
    addOutputVatCents: number;
    addInputVatCents: number;
    addNetCents: number;
  };
  surcharge: {
    cents: number;
    months: number;
    originalDueDate: string;
    cappedAt200pct: boolean;
  };
  blueprintLines: Array<{
    accountCode: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
  }>;
  /** True when there's nothing to amend — recomputation matches previous to the satang. */
  noChange: boolean;
}

export interface PP30FilingSnapshot {
  id: string;
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  status: 'filed' | 'amended';
  amendmentSequence: number;
  filedAt: string;
  surchargeCents: number;
  additionalVatPayableCents: number;
}

export interface AmendmentResult {
  filing: PP30FilingSnapshot & { originalFilingId: string };
  closingJournalId: string;
  branch: 'more_payable' | 'more_refund' | 'wash';
  surchargeCents: number;
  surchargeMonths: number;
  newlyStampedOrderCount: number;
  newlyStampedBillCount: number;
  rrestampedOrderCount: number;
  restampedBillCount: number;
}

@Injectable()
export class Pp30AmendmentService {
  private readonly logger = new Logger(Pp30AmendmentService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pp30: PP30Service,
    private readonly journals: JournalRepository,
  ) {}

  /**
   * Read-only preview of the amendment delta + surcharge calc.
   *
   * Does NOT mutate state — safe to poll. Throws NotFoundException when no
   * previous filing exists (caller should use the Pp30ClosingService for first-time close).
   */
  async preview(
    year: number,
    month: number,
    amendmentDate: Date = new Date(),
  ): Promise<AmendmentPreview> {
    requireValidPeriod(year, month);
    const previous = await this.findActiveFiling(year, month);
    if (!previous) {
      throw new NotFoundException(
        `PP.30 ${periodLabel(year, month)} has no active filing. Close the period first via /api/reports/pp30/close.`,
      );
    }

    // Recompute output VAT from PP30Service — already does the CN/DN math.
    const output = await this.pp30.forMonth(year, month);
    const recomputedOutputCents = Math.max(0, output.net.outputVatAfterCN);
    // Recompute eligible input VAT — same logic as initial close, but here we
    // include ALL bills with tax-point in/before period AND status posted/...
    // AND not reclassed, regardless of pp30_filing_id stamping (the stamping is
    // a "what was claimed when" audit trail, not an eligibility filter for the
    // re-aggregate).
    const inputAgg = await this.aggregateAllEligibleInput(year, month);
    const recomputedInputCents = inputAgg.totalCents;
    const recomputedNet = recomputedOutputCents - recomputedInputCents;

    const addOutputCents = recomputedOutputCents - previous.outputVatCents;
    const addInputCents = recomputedInputCents - previous.inputVatCents;
    const addNet = addOutputCents - addInputCents;

    const surcharge = computeSurcharge({
      additionalVatPayableCents: Math.max(0, addNet),
      periodYear: year,
      periodMonth: month,
      amendmentDate,
    });

    // Build the blueprint to surface the journal lines in the preview.
    let blueprintLines: AmendmentPreview['blueprintLines'] = [];
    let noChange = false;
    try {
      const bp = buildAmendmentBlueprint({
        addOutputVatCents: addOutputCents,
        addInputVatCents: addInputCents,
        surchargeCents: surcharge.surchargeCents,
      });
      blueprintLines = bp.lines.map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      }));
    } catch (e: any) {
      if (e?.code === 'NO_DELTA') {
        noChange = true;
      } else {
        throw e;
      }
    }

    return {
      periodYear: year,
      periodMonth: month,
      periodLabel: periodLabel(year, month),
      previous: snapshotPrev(previous),
      recomputed: {
        outputVatCents: recomputedOutputCents,
        inputVatCents: recomputedInputCents,
        netPayableCents: recomputedNet,
        contributingOrderCount:
          output.source.orderCount + output.source.creditNoteCount,
        contributingBillCount: inputAgg.billCount,
      },
      delta: {
        addOutputVatCents: addOutputCents,
        addInputVatCents: addInputCents,
        addNetCents: addNet,
      },
      surcharge: {
        cents: surcharge.surchargeCents,
        months: surcharge.surchargeMonths,
        originalDueDate: surcharge.originalDueDate,
        cappedAt200pct: surcharge.cappedAt200pct,
      },
      blueprintLines,
      noChange,
    };
  }

  /**
   * Atomic amendment. Marks the previous filing 'amended', inserts the new
   * 'filed' row, posts the delta journal, restamps the contributing rows.
   * Refuses to run when there's nothing to amend (NoChange → BadRequest).
   */
  async amend(
    year: number,
    month: number,
    opts: {
      filedBy?: string | null;
      rdFilingReference?: string;
      notes?: string;
      amendmentDate?: Date;
    } = {},
  ): Promise<AmendmentResult> {
    requireValidPeriod(year, month);
    const amendmentDate = opts.amendmentDate ?? new Date();

    // Pre-flight: must have a current filing.
    const preCheck = await this.findActiveFiling(year, month);
    if (!preCheck) {
      throw new NotFoundException(
        `PP.30 ${periodLabel(year, month)} has no active filing to amend.`,
      );
    }

    return this.db.transaction(async (tx) => {
      // Re-take the active filing inside the tx with row lock.
      const lockedRows = await tx.execute<{
        id: string;
        output_vat_cents: number;
        input_vat_cents: number;
        net_payable_cents: number;
        amendment_sequence: number;
        original_filing_id: string | null;
      }>(sql`
        SELECT id, output_vat_cents, input_vat_cents, net_payable_cents,
               amendment_sequence, original_filing_id
          FROM custom.pp30_filings
         WHERE period_year = ${year}
           AND period_month = ${month}
           AND status = 'filed'
         FOR UPDATE
      `);
      const lockedArr = ((lockedRows as any).rows ?? lockedRows) as any[];
      if (lockedArr.length === 0) {
        throw new ConflictException(
          `PP.30 ${periodLabel(year, month)} has no active filing inside tx (raced with another amendment).`,
        );
      }
      const previousLocked = lockedArr[0];
      const previousId = previousLocked.id as string;
      const previousOutput = Number(previousLocked.output_vat_cents);
      const previousInput = Number(previousLocked.input_vat_cents);
      const previousAmendSeq = Number(previousLocked.amendment_sequence ?? 0);
      // The ROOT filing (sequence 0) — always the head of the chain.
      const rootFilingId =
        previousLocked.original_filing_id ?? previousId;

      // Recompute fresh inside the tx — bills posted between preview() and
      // amend() can't sneak around us.
      const output = await this.pp30.forMonth(year, month);
      const recomputedOutputCents = Math.max(0, output.net.outputVatAfterCN);
      const inputAgg = await this.aggregateAllEligibleInputTx(tx as any, year, month);
      const recomputedInputCents = inputAgg.totalCents;
      const recomputedNet = recomputedOutputCents - recomputedInputCents;

      const addOutputCents = recomputedOutputCents - previousOutput;
      const addInputCents = recomputedInputCents - previousInput;
      const addNet = addOutputCents - addInputCents;

      const surcharge = computeSurcharge({
        additionalVatPayableCents: Math.max(0, addNet),
        periodYear: year,
        periodMonth: month,
        amendmentDate,
      });

      let blueprint;
      try {
        blueprint = buildAmendmentBlueprint({
          addOutputVatCents: addOutputCents,
          addInputVatCents: addInputCents,
          surchargeCents: surcharge.surchargeCents,
        });
      } catch (e: any) {
        if (e?.code === 'NO_DELTA') {
          throw new BadRequestException(
            `PP.30.2 ${periodLabel(year, month)} — nothing to amend (recomputed totals match the previous filing).`,
          );
        }
        throw e;
      }

      // Step 1: mark previous as amended. This releases the partial UNIQUE so
      // we can insert the new 'filed' row.
      await tx
        .update(pp30Filings)
        .set({ status: 'amended' })
        .where(eq(pp30Filings.id, previousId));

      // Step 2: insert the new active filing.
      const [newFiling] = await tx
        .insert(pp30Filings)
        .values({
          periodYear: year,
          periodMonth: month,
          outputVatCents: recomputedOutputCents,
          inputVatCents: recomputedInputCents,
          netPayableCents: recomputedNet,
          status: 'filed',
          filedAt: amendmentDate,
          filedBy:
            opts.filedBy && isUuid(opts.filedBy) ? opts.filedBy : null,
          rdFilingReference: opts.rdFilingReference ?? null,
          notes: opts.notes ?? null,
          originalFilingId: rootFilingId,
          amendmentSequence: previousAmendSeq + 1,
          surchargeCents: surcharge.surchargeCents,
          surchargeMonths: surcharge.surchargeMonths,
          additionalVatPayableCents: addNet,
        })
        .returning();

      // Step 3: post the delta journal.
      const entry = JournalEntry.create({
        date: lastDayOfMonth(year, month),
        description: `PP.30.2 amendment ${periodLabel(year, month)} #${
          previousAmendSeq + 1
        } (${blueprint.branch})`,
        reference: newFiling.id,
        sourceModule: 'reports.pp30-amend',
        sourceId: newFiling.id,
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
        postedBy:
          opts.filedBy && isUuid(opts.filedBy) ? opts.filedBy : null,
      });

      await tx
        .update(pp30Filings)
        .set({ closingJournalId: posted.id })
        .where(eq(pp30Filings.id, newFiling.id));

      // Step 4: restamp contributing rows so pp30_filing_id always points at
      // the currently active filing for the period.
      // Bills: stamp those that are eligible (tax-point in/before period, not
      // reclassed) AND either unstamped OR stamped to the now-amended filing
      // OR stamped to any earlier filing in the chain.
      const periodEnd = lastDayOfMonth(year, month);
      const billUpdates = await tx.execute<{ count: string }>(sql`
        WITH eligible AS (
          UPDATE custom.vendor_bills
             SET pp30_filing_id = ${newFiling.id}, updated_at = NOW()
           WHERE vat_cents > 0
             AND status IN ('posted','partially_paid','paid')
             AND COALESCE(supplier_tax_invoice_date, bill_date) <= ${periodEnd}
             AND input_vat_reclassed_at IS NULL
             AND (pp30_filing_id IS NULL
                  OR pp30_filing_id IN (
                    SELECT id FROM custom.pp30_filings
                     WHERE period_year = ${year} AND period_month = ${month}
                  ))
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM eligible
      `);
      const billsTouched = Number(
        (((billUpdates as any).rows ?? billUpdates) as any[])[0]?.count ?? 0,
      );

      const fromTs = new Date(Date.UTC(year, month - 1, 1));
      const toTs = new Date(Date.UTC(year, month, 1));
      const orderUpdates = await tx.execute<{ count: string }>(sql`
        WITH eligible AS (
          UPDATE custom.pos_orders
             SET pp30_filing_id = ${newFiling.id}, updated_at = NOW()
           WHERE created_at >= ${fromTs.toISOString()}::timestamptz
             AND created_at <  ${toTs.toISOString()}::timestamptz
             AND (pp30_filing_id IS NULL
                  OR pp30_filing_id IN (
                    SELECT id FROM custom.pp30_filings
                     WHERE period_year = ${year} AND period_month = ${month}
                  ))
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM eligible
      `);
      const ordersTouched = Number(
        (((orderUpdates as any).rows ?? orderUpdates) as any[])[0]?.count ?? 0,
      );

      this.logger.log(
        `PP.30.2 amend ${periodLabel(year, month)} #${previousAmendSeq + 1} — ` +
          `addOut=${addOutputCents} addIn=${addInputCents} addNet=${addNet} ` +
          `surcharge=${surcharge.surchargeCents} (${surcharge.surchargeMonths}mo) ` +
          `bills=${billsTouched} orders=${ordersTouched}`,
      );

      return {
        filing: {
          id: newFiling.id,
          outputVatCents: recomputedOutputCents,
          inputVatCents: recomputedInputCents,
          netPayableCents: recomputedNet,
          status: 'filed',
          amendmentSequence: previousAmendSeq + 1,
          filedAt:
            newFiling.filedAt instanceof Date
              ? newFiling.filedAt.toISOString()
              : (newFiling.filedAt as unknown as string),
          surchargeCents: surcharge.surchargeCents,
          additionalVatPayableCents: addNet,
          originalFilingId: rootFilingId,
        },
        closingJournalId: posted.id,
        branch: blueprint.branch,
        surchargeCents: surcharge.surchargeCents,
        surchargeMonths: surcharge.surchargeMonths,
        newlyStampedOrderCount: ordersTouched,
        newlyStampedBillCount: billsTouched,
        rrestampedOrderCount: 0, // restamping included in newly stamped via the IN clause
        restampedBillCount: 0,
      };
    });
  }

  /** Lookup helper — used by preview() and the GET endpoint. */
  async findActiveFiling(year: number, month: number) {
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
    return rows[0] ?? null;
  }

  /**
   * List the full lineage of filings for a period (chronological).
   * Useful for the operator UI's "amendment history" view.
   */
  async lineage(year: number, month: number) {
    requireValidPeriod(year, month);
    const rows = await this.db
      .select()
      .from(pp30Filings)
      .where(
        and(
          eq(pp30Filings.periodYear, year),
          eq(pp30Filings.periodMonth, month),
        ),
      )
      .orderBy(pp30Filings.amendmentSequence);
    return rows.map((r) => ({
      id: r.id,
      amendmentSequence: Number(r.amendmentSequence ?? 0),
      status: r.status as 'filed' | 'amended',
      outputVatCents: Number(r.outputVatCents),
      inputVatCents: Number(r.inputVatCents),
      netPayableCents: Number(r.netPayableCents),
      additionalVatPayableCents: Number(r.additionalVatPayableCents ?? 0),
      surchargeCents: Number(r.surchargeCents ?? 0),
      surchargeMonths: Number(r.surchargeMonths ?? 0),
      originalFilingId: r.originalFilingId ?? null,
      closingJournalId: r.closingJournalId ?? null,
      filedAt:
        r.filedAt instanceof Date
          ? r.filedAt.toISOString()
          : (r.filedAt as unknown as string),
      filedBy: r.filedBy ?? null,
      rdFilingReference: r.rdFilingReference ?? null,
      notes: r.notes ?? null,
    }));
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Sum input VAT for bills eligible for THIS period's amended filing.
   *
   * Eligibility: status posted/partially_paid/paid, tax-point ≤ period end,
   * not reclassed, AND either unstamped OR stamped to one of THIS period's
   * filings (current or superseded). The "stamped to a different period"
   * exclusion prevents double-claiming a bill that was already counted in a
   * different month's PP.30.
   */
  private async aggregateAllEligibleInput(year: number, month: number) {
    const periodEnd = lastDayOfMonth(year, month);
    const rows = await this.db.execute<{ id: string; vat_cents: number }>(sql`
      SELECT id, vat_cents
        FROM custom.vendor_bills
       WHERE vat_cents > 0
         AND status IN ('posted','partially_paid','paid')
         AND COALESCE(supplier_tax_invoice_date, bill_date) <= ${periodEnd}
         AND input_vat_reclassed_at IS NULL
         AND (pp30_filing_id IS NULL
              OR pp30_filing_id IN (
                SELECT id FROM custom.pp30_filings
                 WHERE period_year = ${year} AND period_month = ${month}
              ))
    `);
    const flat = ((rows as any).rows ?? rows) as Array<{ id: string; vat_cents: number }>;
    return {
      totalCents: flat.reduce((s, r) => s + Number(r.vat_cents), 0),
      billCount: flat.length,
    };
  }

  /** Same as aggregateAllEligibleInput but inside a tx. */
  private async aggregateAllEligibleInputTx(
    tx: Database,
    year: number,
    month: number,
  ) {
    const periodEnd = lastDayOfMonth(year, month);
    const rows = await tx.execute<{ id: string; vat_cents: number }>(sql`
      SELECT id, vat_cents
        FROM custom.vendor_bills
       WHERE vat_cents > 0
         AND status IN ('posted','partially_paid','paid')
         AND COALESCE(supplier_tax_invoice_date, bill_date) <= ${periodEnd}
         AND input_vat_reclassed_at IS NULL
         AND (pp30_filing_id IS NULL
              OR pp30_filing_id IN (
                SELECT id FROM custom.pp30_filings
                 WHERE period_year = ${year} AND period_month = ${month}
              ))
    `);
    const flat = ((rows as any).rows ?? rows) as Array<{ id: string; vat_cents: number }>;
    return {
      totalCents: flat.reduce((s, r) => s + Number(r.vat_cents), 0),
      billCount: flat.length,
    };
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
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

function snapshotPrev(r: any): PP30FilingSnapshot {
  return {
    id: r.id,
    outputVatCents: Number(r.outputVatCents),
    inputVatCents: Number(r.inputVatCents),
    netPayableCents: Number(r.netPayableCents),
    status: r.status,
    amendmentSequence: Number(r.amendmentSequence ?? 0),
    filedAt:
      r.filedAt instanceof Date
        ? r.filedAt.toISOString()
        : r.filedAt,
    surchargeCents: Number(r.surchargeCents ?? 0),
    additionalVatPayableCents: Number(r.additionalVatPayableCents ?? 0),
  };
}
