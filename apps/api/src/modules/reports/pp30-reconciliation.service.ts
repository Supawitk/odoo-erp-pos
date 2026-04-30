import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  journalEntries,
  journalEntryLines,
  vendorBills,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { PP30Service } from './pp30.service';

/**
 * 🇹🇭 PP.30 ↔ GL reconciliation.
 *
 * Catches the most expensive Phase 4 bug class: the PP.30 form (computed from
 * pos_orders.vat_breakdown) drifts from the GL (computed from journal lines
 * touching 2201 Output VAT / 1155 Input VAT). If they disagree, *one* of them
 * is wrong:
 *   - PP.30 wrong → we under-/over-remit to RD next month (1.5%/mo surcharge)
 *   - GL wrong    → financial statements are off
 *
 * Either way the merchant needs to know NOW, not at year-end.
 *
 * What this service does:
 *   1. Compute PP.30 form numbers (output VAT after CN, input VAT claimed).
 *   2. Aggregate journal lines hitting 2201 / 1155 / 1156 / 1157 in the period
 *      from POSTED entries only.
 *   3. Surface the deltas; flag |delta| > ฿1 as a problem (1 baht is the
 *      rounding tolerance — VAT is computed at the line level and pennies
 *      can drift legitimately on inclusive-mode invoices).
 */
export interface Pp30Reconciliation {
  period: string; // YYYYMM
  pp30: {
    outputVatGrossCents: number;
    refundedVatCents: number;
    outputVatNetCents: number;
    inputVatClaimedCents: number; // currently from purchase-side (vendor bills)
    netVatPayableCents: number;
  };
  gl: {
    outputVatCreditCents: number;   // Σ credits to 2201
    outputVatDebitCents: number;    // Σ debits to 2201 (refund / void)
    outputVatNetCents: number;      // credit − debit
    inputVatDebitCents: number;     // Σ debits to 1155
    inputVatCreditCents: number;    // Σ credits to 1155 (reversals)
    inputVatNetCents: number;
    deferredOutputCents: number;    // 2202
    deferredInputCents: number;     // 1156
  };
  delta: {
    outputVatCents: number; // gl.outputVatNetCents − pp30.outputVatNetCents
    inputVatCents: number;  // gl.inputVatNetCents  − pp30.inputVatClaimedCents
  };
  /** True iff |delta| ≤ ฿1 on both sides. */
  reconciled: boolean;
  source: {
    journalEntryCount: number;
    vendorBillCount: number;
  };
}

const TOLERANCE_CENTS = 100; // ฿1

@Injectable()
export class Pp30ReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pp30: PP30Service,
  ) {}

  async forMonth(year: number, month: number): Promise<Pp30Reconciliation> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const period = `${year}${String(month).padStart(2, '0')}`;

    // ── PP.30 (sales side, computed from pos_orders.vat_breakdown)
    const pp30 = await this.pp30.forMonth(year, month);

    // ── Input VAT claimed: sum of vat_cents from vendor bills posted in period
    //    (the post date is the tax-point for input VAT under §82/3).
    const billRows = await this.db
      .select({
        vatCents: vendorBills.vatCents,
      })
      .from(vendorBills)
      .where(
        and(
          gte(vendorBills.postedAt, from),
          lt(vendorBills.postedAt, to),
          sql`${vendorBills.status} IN ('posted','paid')`,
        ),
      );
    const inputVatClaimedCents = billRows.reduce(
      (s, r) => s + Number(r.vatCents ?? 0),
      0,
    );

    // ── GL aggregates by VAT account in the period (posted entries only)
    const glRows = await this.db
      .select({
        accountCode: journalEntryLines.accountCode,
        debitCents: sql<number>`COALESCE(SUM(${journalEntryLines.debitCents}), 0)::bigint`,
        creditCents: sql<number>`COALESCE(SUM(${journalEntryLines.creditCents}), 0)::bigint`,
        entryCount: sql<number>`COUNT(DISTINCT ${journalEntries.id})::int`,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        eq(journalEntryLines.journalEntryId, journalEntries.id),
      )
      .where(
        and(
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, isoDate(from)),
          lt(journalEntries.date, isoDate(to)),
          sql`${journalEntryLines.accountCode} IN ('2201','2202','1155','1156')`,
        ),
      )
      .groupBy(journalEntryLines.accountCode);

    let outputVatCredit = 0;
    let outputVatDebit = 0;
    let inputVatDebit = 0;
    let inputVatCredit = 0;
    let deferredOutput = 0;
    let deferredInput = 0;
    let entryCount = 0;
    for (const r of glRows) {
      const d = Number(r.debitCents);
      const c = Number(r.creditCents);
      entryCount += Number(r.entryCount);
      switch (r.accountCode) {
        case '2201':
          outputVatCredit += c;
          outputVatDebit += d;
          break;
        case '2202':
          deferredOutput += c - d;
          break;
        case '1155':
          inputVatDebit += d;
          inputVatCredit += c;
          break;
        case '1156':
          deferredInput += d - c;
          break;
      }
    }

    const outputVatNet = outputVatCredit - outputVatDebit;
    const inputVatNet = inputVatDebit - inputVatCredit;
    const deltaOut = outputVatNet - pp30.net.outputVatAfterCN;
    const deltaIn = inputVatNet - inputVatClaimedCents;

    return {
      period,
      pp30: {
        outputVatGrossCents: pp30.outputVatCents,
        refundedVatCents: pp30.refundedVatCents,
        outputVatNetCents: pp30.net.outputVatAfterCN,
        inputVatClaimedCents,
        netVatPayableCents: pp30.net.outputVatAfterCN - inputVatClaimedCents,
      },
      gl: {
        outputVatCreditCents: outputVatCredit,
        outputVatDebitCents: outputVatDebit,
        outputVatNetCents: outputVatNet,
        inputVatDebitCents: inputVatDebit,
        inputVatCreditCents: inputVatCredit,
        inputVatNetCents: inputVatNet,
        deferredOutputCents: deferredOutput,
        deferredInputCents: deferredInput,
      },
      delta: {
        outputVatCents: deltaOut,
        inputVatCents: deltaIn,
      },
      reconciled:
        Math.abs(deltaOut) <= TOLERANCE_CENTS &&
        Math.abs(deltaIn) <= TOLERANCE_CENTS,
      source: {
        journalEntryCount: entryCount,
        vendorBillCount: billRows.length,
      },
    };
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
