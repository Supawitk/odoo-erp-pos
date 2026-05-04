import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { partners, vendorBills, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * 🇹🇭 Input VAT 6-month expiry tracker — Revenue Code §82/3 / §2.8.
 *
 * The rule: VAT paid on a vendor invoice is claimable in the tax-point month
 * OR any of the following 6 calendar months. Past that window the input VAT
 * is permanently lost — it cannot be claimed on PP.30, period.
 *
 * Tax-point = supplier_tax_invoice_date when captured (it's the date on the
 * supplier's tax invoice, which is what RD recognises). Falls back to
 * bill_date for bills entered without the supplier-side detail (rare; flagged).
 *
 * Status taxonomy:
 *   claimed       bill posted into the GL → input VAT booked to 1155 and
 *                 still claimable (window not yet expired). (status ∈
 *                 posted/partially_paid/paid AND tax-point + 6mo ≥ today)
 *   reclassified  bill was past 6 months and the auto-reclass cron has
 *                 already moved 1155 → 6390 (input_vat_reclassed_at IS NOT
 *                 NULL). No further action needed; surfaced for traceability.
 *   claimable     bill is draft AND days-remaining > 30
 *   expiring_soon bill is draft AND 0 ≤ days-remaining ≤ 30
 *   expired       bill is draft AND days-remaining < 0  — OR bill is posted
 *                 past 6 months and not yet reclassed (cron will get it
 *                 tonight). PERMANENT loss either way.
 */
export interface InputVatExpiryRow {
  billId: string;
  internalNumber: string;
  supplierId: string;
  supplierName: string;
  supplierTin: string | null;
  billDate: string;
  supplierTaxInvoiceDate: string | null;
  /** The earlier of supplier_tax_invoice_date and bill_date. */
  taxPointDate: string;
  vatCents: number;
  status: 'claimed' | 'reclassified' | 'claimable' | 'expiring_soon' | 'expired';
  /** Days until claim window closes; negative when already past. */
  daysRemaining: number;
  /** When the 6-month window ends (yyyy-mm-dd). */
  claimDeadline: string;
  billStatus: 'draft' | 'posted' | 'partially_paid' | 'paid' | 'void';
  /** When the auto-reclass cron moved this bill's 1155 to 6390. */
  reclassifiedAt: string | null;
}

export interface InputVatExpirySummary {
  asOf: string;
  totals: {
    claimed: { count: number; vatCents: number };
    reclassified: { count: number; vatCents: number };
    claimable: { count: number; vatCents: number };
    expiringSoon: { count: number; vatCents: number };
    expired: { count: number; vatCents: number };
  };
  rows: InputVatExpiryRow[];
}

@Injectable()
export class InputVatExpiryService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Classify every bill that has VAT > 0. Default scope is the trailing
   * 12 months from today so the response is bounded; pass a from-date to
   * widen.
   */
  async report(opts: { from?: string; to?: string } = {}): Promise<InputVatExpirySummary> {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const fromIso = opts.from ?? subtractMonths(today, 12).toISOString().slice(0, 10);
    const toIso = opts.to ?? todayIso;

    const rows = await this.db
      .select({
        billId: vendorBills.id,
        internalNumber: vendorBills.internalNumber,
        supplierId: vendorBills.supplierId,
        supplierName: partners.name,
        supplierTin: partners.tin,
        billDate: vendorBills.billDate,
        supplierTaxInvoiceDate: vendorBills.supplierTaxInvoiceDate,
        vatCents: vendorBills.vatCents,
        billStatus: vendorBills.status,
        reclassedAt: vendorBills.inputVatReclassedAt,
      })
      .from(vendorBills)
      .leftJoin(partners, eq(partners.id, vendorBills.supplierId))
      .where(
        and(
          sql`${vendorBills.vatCents} > 0`,
          sql`${vendorBills.billDate} >= ${fromIso}`,
          sql`${vendorBills.billDate} <= ${toIso}`,
          sql`${vendorBills.status} != 'void'`,
        ),
      )
      .orderBy(asc(vendorBills.billDate));

    const out: InputVatExpiryRow[] = rows.map((r) => {
      const taxPoint = r.supplierTaxInvoiceDate ?? r.billDate;
      const deadline = addMonths(parseDate(taxPoint), 6);
      const deadlineIso = deadline.toISOString().slice(0, 10);
      const daysRemaining = Math.floor(
        (deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );

      const billStatus = r.billStatus as InputVatExpiryRow['billStatus'];
      const isPosted =
        billStatus === 'posted' ||
        billStatus === 'partially_paid' ||
        billStatus === 'paid';
      let status: InputVatExpiryRow['status'];
      if (r.reclassedAt) {
        status = 'reclassified';
      } else if (isPosted && daysRemaining < 0) {
        // Posted but past the window AND cron hasn't run yet — surfaces as
        // expired so the operator sees the same red row both pre- and post-cron.
        status = 'expired';
      } else if (isPosted) {
        status = 'claimed';
      } else if (daysRemaining < 0) {
        status = 'expired';
      } else if (daysRemaining <= 30) {
        status = 'expiring_soon';
      } else {
        status = 'claimable';
      }

      return {
        billId: r.billId,
        internalNumber: r.internalNumber,
        supplierId: r.supplierId,
        supplierName: r.supplierName ?? '(unknown)',
        supplierTin: r.supplierTin ?? null,
        billDate: r.billDate,
        supplierTaxInvoiceDate: r.supplierTaxInvoiceDate,
        taxPointDate: taxPoint,
        vatCents: Number(r.vatCents),
        status,
        daysRemaining,
        claimDeadline: deadlineIso,
        billStatus,
        reclassifiedAt: r.reclassedAt ? new Date(r.reclassedAt).toISOString() : null,
      };
    });

    const totals = out.reduce(
      (acc, r) => {
        const slot =
          r.status === 'claimed'
            ? acc.claimed
            : r.status === 'reclassified'
            ? acc.reclassified
            : r.status === 'claimable'
            ? acc.claimable
            : r.status === 'expiring_soon'
            ? acc.expiringSoon
            : acc.expired;
        slot.count += 1;
        slot.vatCents += r.vatCents;
        return acc;
      },
      {
        claimed: { count: 0, vatCents: 0 },
        reclassified: { count: 0, vatCents: 0 },
        claimable: { count: 0, vatCents: 0 },
        expiringSoon: { count: 0, vatCents: 0 },
        expired: { count: 0, vatCents: 0 },
      },
    );

    return { asOf: todayIso, totals, rows: out };
  }
}

// Date arithmetic helpers — month-boundary-safe.
function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  const targetMonth = out.getUTCMonth() + months;
  out.setUTCMonth(targetMonth);
  return out;
}

function subtractMonths(d: Date, months: number): Date {
  return addMonths(d, -months);
}
