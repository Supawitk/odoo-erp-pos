import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { partners, vendorBills, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../accounting/infrastructure/journal.repository';
import { JournalEntry } from '../accounting/domain/journal-entry';
import {
  evaluateReclassEligibility,
  addMonthsIso,
} from './input-vat-reclass.eligibility';

/**
 * 🇹🇭 Auto-reclass cron — Revenue Code §82/3.
 *
 * Once the 6-month claim window for a bill's input VAT has lapsed, the right
 * to credit it on PP.30 is permanently lost. The amount sitting in 1155 is no
 * longer a tax receivable; it is a real cost incurred (deductible for CIT
 * under §65). This cron moves it:
 *
 *   Dr 6390 ภาษีซื้อหมดอายุ (Expired Input VAT)   ← CIT-deductible OpEx
 *     Cr 1155 Input VAT
 *
 * Idempotency: each bill carries `input_vat_reclassed_at` + the journal id of
 * its reclass entry. Re-running the cron is a no-op for already-reclassed
 * bills. The eligibility predicate is pure and tested independently
 * (`input-vat-reclass.eligibility.test.ts`).
 *
 * Schedule: daily 04:30 ICT — after the goods-report cron (02:00) and before
 * users typically log in.
 */

const RECLASS_DEBIT_ACCOUNT = '6390';
const RECLASS_DEBIT_NAME = 'ภาษีซื้อหมดอายุ (Expired Input VAT)';
const INPUT_VAT_ACCOUNT = '1155';

export interface ReclassPreviewRow {
  billId: string;
  internalNumber: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  taxPointDate: string;
  claimDeadline: string;
  daysOverdue: number;
  vatCents: number;
  status: string;
}

export interface ReclassRunResult {
  asOf: string;
  dryRun: boolean;
  reclassed: number;
  totalReclassedCents: number;
  rows: Array<{
    billId: string;
    internalNumber: string;
    vatCents: number;
    journalEntryId: string | null;
    error?: string;
  }>;
}

@Injectable()
export class InputVatReclassService {
  private readonly logger = new Logger(InputVatReclassService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
  ) {}

  /**
   * Read-only preview: which bills are CURRENTLY eligible? UI uses this to
   * surface "what the cron would do tonight" before the run actually fires.
   */
  async preview(opts: { asOf?: string } = {}): Promise<ReclassPreviewRow[]> {
    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
    const rows = await this.queryCandidates(asOf);
    return rows.map((r) => ({
      billId: r.billId,
      internalNumber: r.internalNumber,
      supplierId: r.supplierId,
      supplierName: r.supplierName ?? '(unknown)',
      billDate: r.billDate,
      taxPointDate: r.taxPoint,
      claimDeadline: r.deadline,
      daysOverdue: r.daysOverdue,
      vatCents: r.vatCents,
      status: r.status,
    }));
  }

  /**
   * Actually post the reclass journals. Each bill is processed independently —
   * one bill's failure doesn't block the rest. The handler stamps the bill
   * BEFORE returning so a partial run that crashes mid-bill leaves the
   * already-processed rows correctly recorded.
   *
   * dryRun: when true, returns the same shape but writes nothing (used by the
   * cron's first invocation per install for trust-building).
   */
  async run(
    opts: { asOf?: string; dryRun?: boolean; postedBy?: string | null } = {},
  ): Promise<ReclassRunResult> {
    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
    const dryRun = opts.dryRun ?? false;
    const candidates = await this.queryCandidates(asOf);

    let totalCents = 0;
    const rows: ReclassRunResult['rows'] = [];

    for (const c of candidates) {
      try {
        if (dryRun) {
          rows.push({
            billId: c.billId,
            internalNumber: c.internalNumber,
            vatCents: c.vatCents,
            journalEntryId: null,
          });
          totalCents += c.vatCents;
          continue;
        }
        // Race-safe re-check inside a row lock so two cron pods can't both
        // post for the same bill. The condition vs `input_vat_reclassed_at IS
        // NULL` makes the UPDATE a fence — if another worker set it first,
        // our update affects 0 rows and we skip.
        const journalId = await this.reclassOne(
          c.billId,
          asOf,
          c.vatCents,
          c.internalNumber,
          opts.postedBy ?? null,
        );
        if (journalId) {
          rows.push({
            billId: c.billId,
            internalNumber: c.internalNumber,
            vatCents: c.vatCents,
            journalEntryId: journalId,
          });
          totalCents += c.vatCents;
        }
      } catch (e: any) {
        this.logger.error(
          `Reclass failed for bill ${c.internalNumber} (${c.billId}): ${e?.message ?? e}`,
        );
        rows.push({
          billId: c.billId,
          internalNumber: c.internalNumber,
          vatCents: c.vatCents,
          journalEntryId: null,
          error: e?.message ?? String(e),
        });
      }
    }

    if (!dryRun && rows.length > 0) {
      this.logger.log(
        `Reclassed ${rows.filter((r) => r.journalEntryId).length}/${candidates.length} bills, ${totalCents}c moved 1155 → ${RECLASS_DEBIT_ACCOUNT} (asOf=${asOf})`,
      );
    }
    return { asOf, dryRun, reclassed: rows.filter((r) => r.journalEntryId).length, totalReclassedCents: totalCents, rows };
  }

  // The 04:30 ICT daily run is wired via JobsProcessor (BullMQ). This service
  // exposes `run()` directly; the processor case for 'input-vat-reclass'
  // calls run({ dryRun: false, postedBy: null }).

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * SQL-level filter mirrors the predicate to keep the candidate set small.
   * The pure predicate is then re-applied per row so any future divergence
   * surfaces (e.g. when we add the `input_vat_disallow_reason` column it
   * goes here without changing the SQL).
   */
  private async queryCandidates(asOf: string) {
    const rows = await this.db
      .select({
        billId: vendorBills.id,
        internalNumber: vendorBills.internalNumber,
        supplierId: vendorBills.supplierId,
        supplierName: partners.name,
        billDate: vendorBills.billDate,
        supplierTaxInvoiceDate: vendorBills.supplierTaxInvoiceDate,
        vatCents: vendorBills.vatCents,
        status: vendorBills.status,
        currency: vendorBills.currency,
        inputVatReclassedAt: vendorBills.inputVatReclassedAt,
        pp30FilingId: vendorBills.pp30FilingId,
      })
      .from(vendorBills)
      .leftJoin(partners, eq(partners.id, vendorBills.supplierId))
      .where(
        and(
          sql`${vendorBills.vatCents} > 0`,
          sql`${vendorBills.status} IN ('posted','partially_paid','paid')`,
          isNull(vendorBills.inputVatReclassedAt),
          isNull(vendorBills.pp30FilingId),
        ),
      )
      .orderBy(asc(vendorBills.billDate));

    return rows
      .map((r) => {
        const e = evaluateReclassEligibility({
          status: r.status,
          vatCents: Number(r.vatCents),
          billDate: String(r.billDate),
          supplierTaxInvoiceDate: r.supplierTaxInvoiceDate
            ? String(r.supplierTaxInvoiceDate)
            : null,
          inputVatReclassedAt: r.inputVatReclassedAt ?? null,
          pp30FilingId: r.pp30FilingId ?? null,
          asOf,
        });
        return { row: r, eligibility: e };
      })
      .filter((x) => x.eligibility.eligible)
      .map((x) => ({
        billId: x.row.billId,
        internalNumber: x.row.internalNumber,
        supplierId: x.row.supplierId,
        supplierName: x.row.supplierName,
        billDate: String(x.row.billDate),
        taxPoint: x.eligibility.taxPointDate,
        deadline: x.eligibility.claimDeadline,
        daysOverdue: x.eligibility.daysOverdue,
        vatCents: Number(x.row.vatCents),
        status: x.row.status,
        currency: x.row.currency,
      }));
  }

  private async reclassOne(
    billId: string,
    asOf: string,
    vatCents: number,
    internalNumber: string,
    postedBy: string | null,
  ): Promise<string | null> {
    return await this.db.transaction(async (tx) => {
      // Lock + re-check under the same row to defeat double-cron races.
      const billRows = await tx
        .select({
          id: vendorBills.id,
          currency: vendorBills.currency,
          inputVatReclassedAt: vendorBills.inputVatReclassedAt,
          status: vendorBills.status,
          vatCents: vendorBills.vatCents,
        })
        .from(vendorBills)
        .where(eq(vendorBills.id, billId))
        .for('update')
        .limit(1);
      const bill = billRows[0];
      if (!bill || bill.inputVatReclassedAt) return null;

      const entry = JournalEntry.create({
        date: asOf,
        description: `Expired input VAT reclass — ${internalNumber} (§82/3)`,
        reference: internalNumber,
        sourceModule: 'purchasing.input-vat-reclass',
        sourceId: billId,
        currency: bill.currency,
        lines: [
          {
            accountCode: RECLASS_DEBIT_ACCOUNT,
            accountName: RECLASS_DEBIT_NAME,
            debitCents: vatCents,
            creditCents: 0,
          },
          {
            accountCode: INPUT_VAT_ACCOUNT,
            accountName: 'Input VAT (expired claim window)',
            debitCents: 0,
            creditCents: vatCents,
          },
        ],
      });
      const posted = await this.journals.insert(entry, {
        autoPost: true,
        postedBy: isUuid(postedBy) ? postedBy : null,
      });

      await tx
        .update(vendorBills)
        .set({
          inputVatReclassedAt: new Date(),
          inputVatReclassJournalId: posted.id,
          updatedAt: new Date(),
        })
        .where(eq(vendorBills.id, billId));

      return posted.id;
    });
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(x: string | null): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

// Re-export for convenience
export { addMonthsIso };
