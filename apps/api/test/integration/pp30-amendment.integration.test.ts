/**
 * 🇹🇭 PP.30.2 amendment flow — full integration test against the live DB.
 *
 * Walks the realistic scenario:
 *   1. Seed a unique synthetic period (avoid colliding with real fixture data)
 *   2. Insert pos_orders + vendor_bills with VAT
 *   3. Close PP.30 → original filing row, contributing rows stamped
 *   4. Add ANOTHER vendor bill into the closed period (with tax-point inside)
 *   5. preview() → shows additional input VAT, refund-direction, no surcharge
 *   6. amend() → marks original 'amended', inserts new 'filed' with sequence=1
 *      → posts delta journal (Cr 1155 + Dr 1158 only, no surcharge)
 *      → restamps the new bill to the new filing
 *   7. Add a sales order INTO the period (after amendment) → preview shows
 *      additional output VAT, surcharge applies if filed past due date
 *   8. amend() again → sequence=2, surcharge accrued via Dr 6390 / Cr 2210
 *
 * Plus invariants:
 *   - Recompute matches original → BadRequest "nothing to amend"
 *   - Lineage query returns chronological list with all sequences
 *   - Partial UNIQUE never allows two 'filed' rows for same period
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { Pp30AmendmentService } from '../../src/modules/reports/pp30-amendment.service';
import { Pp30ClosingService } from '../../src/modules/reports/pp30-closing.service';
import { PP30Service } from '../../src/modules/reports/pp30.service';
import { JournalRepository } from '../../src/modules/accounting/infrastructure/journal.repository';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

// Use a far-past period so no real fixture data overlaps. Run-unique year.
const TEST_YEAR = 2050;
const TEST_MONTH = 1;
const PERIOD_END = '2050-01-31';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let amend: Pp30AmendmentService;
let close: Pp30ClosingService;

const createdOrderIds: string[] = [];
const createdBillIds: string[] = [];

beforeAll(async () => {
  client = postgres(CONN);
  db = drizzle(client);

  // Instantiate services directly — NestJS DI metadata isn't emitted by vitest.
  const pp30 = new PP30Service(db as any);
  const journals = new JournalRepository(db as any);
  amend = new Pp30AmendmentService(db as any, pp30, journals);
  close = new Pp30ClosingService(db as any, pp30, journals);

  // Pre-clean any leftover rows from a previous test run.
  await client`DELETE FROM custom.pp30_filings WHERE period_year = ${TEST_YEAR} AND period_month = ${TEST_MONTH}`;
});

afterAll(async () => {
  // Cleanup in dependency order: journal_entry_lines → journal_entries (via reference)
  // then pos_orders + vendor_bills + pp30_filings.
  if (createdOrderIds.length > 0) {
    await db.execute(
      sql.raw(
        `DELETE FROM custom.pos_orders WHERE id IN (${createdOrderIds.map((id) => `'${id}'`).join(',')})`,
      ),
    );
  }
  if (createdBillIds.length > 0) {
    await db.execute(
      sql.raw(
        `DELETE FROM custom.vendor_bills WHERE id IN (${createdBillIds.map((id) => `'${id}'`).join(',')})`,
      ),
    );
  }
  // Wipe the synthetic period filings + any journal entries we posted.
  const filingIds: string[] = (
    (await client`SELECT id FROM custom.pp30_filings WHERE period_year = ${TEST_YEAR} AND period_month = ${TEST_MONTH}`) as Array<{ id: string }>
  ).map((r) => r.id);
  if (filingIds.length > 0) {
    await db.execute(
      sql.raw(
        `DELETE FROM custom.journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM custom.journal_entries WHERE source_id IN (${filingIds.map((id) => `'${id}'`).join(',')}))`,
      ),
    );
    await db.execute(
      sql.raw(
        `DELETE FROM custom.journal_entries WHERE source_id IN (${filingIds.map((id) => `'${id}'`).join(',')})`,
      ),
    );
    await db.execute(
      sql.raw(
        `DELETE FROM custom.pp30_filings WHERE id IN (${filingIds.map((id) => `'${id}'`).join(',')})`,
      ),
    );
  }
  await client.end();
});

// ─── helpers ────────────────────────────────────────────────────────────

async function seedOrder(opts: {
  vatCents: number;
  totalCents: number;
}): Promise<string> {
  const id = uuidv7();
  await client`
    INSERT INTO custom.pos_orders (
      id, order_lines, subtotal_cents, tax_cents, discount_cents, total_cents,
      currency, payment_method, status, document_type, document_number,
      vat_breakdown, created_at, updated_at
    ) VALUES (
      ${id}, '[]'::jsonb, ${opts.totalCents - opts.vatCents}, ${opts.vatCents},
      0, ${opts.totalCents}, 'THB', 'cash', 'paid', 'TX',
      ${'TX' + Date.now() + Math.floor(Math.random() * 1000)},
      ${JSON.stringify({
        vatRate: 0.07,
        mode: 'exclusive',
        // PP30Service.forMonth() reads these specific keys.
        taxableNetCents: opts.totalCents - opts.vatCents,
        zeroRatedNetCents: 0,
        exemptNetCents: 0,
        vatCents: opts.vatCents,
      })}::jsonb,
      ${new Date(Date.UTC(TEST_YEAR, TEST_MONTH - 1, 15)).toISOString()}::timestamptz,
      ${new Date(Date.UTC(TEST_YEAR, TEST_MONTH - 1, 15)).toISOString()}::timestamptz
    )
  `;
  createdOrderIds.push(id);
  return id;
}

async function seedBill(opts: { vatCents: number }): Promise<string> {
  const id = uuidv7();
  // Suppliers must exist; reuse any one from the live DB.
  const sup: Array<{ id: string }> = await client`
    SELECT id FROM custom.partners WHERE is_supplier = true LIMIT 1
  `;
  if (sup.length === 0) throw new Error('test setup: no suppliers in DB to attach bill to');
  await client`
    INSERT INTO custom.vendor_bills (
      id, internal_number, supplier_id, status,
      bill_date, supplier_tax_invoice_date, currency, fx_rate_to_thb,
      subtotal_cents, vat_cents, wht_cents, total_cents,
      created_at, updated_at
    ) VALUES (
      ${id},
      ${'TEST-' + Date.now() + Math.floor(Math.random() * 1000)},
      ${sup[0].id}, 'posted',
      ${PERIOD_END}, ${PERIOD_END}, 'THB', 1.0,
      ${opts.vatCents * 14}, ${opts.vatCents}, 0, ${opts.vatCents * 15},
      now(), now()
    )
  `;
  createdBillIds.push(id);
  return id;
}

async function getFiling(year: number, month: number, status: 'filed' | 'amended') {
  const rows: any[] = await client`
    SELECT id, status, output_vat_cents, input_vat_cents, net_payable_cents,
           amendment_sequence, original_filing_id, surcharge_cents,
           additional_vat_payable_cents
      FROM custom.pp30_filings
     WHERE period_year = ${year} AND period_month = ${month} AND status = ${status}
     ORDER BY amendment_sequence DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('PP.30.2 amendment flow — integration', () => {
  it('1. close original PP.30 with one sale + one bill', async () => {
    await seedOrder({ vatCents: 7000, totalCents: 107_000 }); // ฿1,000 sale, ฿70 VAT
    await seedBill({ vatCents: 3500 }); // ฿35 input VAT

    const result = await close.close(TEST_YEAR, TEST_MONTH);
    expect(result.filing.status).toBe('filed');
    expect(result.filing.outputVatCents).toBe(7000);
    expect(result.filing.inputVatCents).toBe(3500);
    expect(result.filing.netPayableCents).toBe(3500); // ฿35 owed to RD
    expect(result.branch).toBe('payable');
  });

  it('2. preview after adding a new bill — refund direction, no surcharge', async () => {
    // Add a missed bill with ฿50 input VAT, tax-point inside the period.
    await seedBill({ vatCents: 5000 });

    // Amend on the due date (no surcharge possible) — Feb 15, 2050.
    // But our TEST_YEAR+TEST_MONTH = 2050-01, so due date = 2050-02-15.
    // Amend exactly on due date: surcharge=0.
    const preview = await amend.preview(
      TEST_YEAR,
      TEST_MONTH,
      new Date(Date.UTC(2050, 1, 15)), // 2050-02-15
    );
    expect(preview.previous.outputVatCents).toBe(7000);
    expect(preview.previous.inputVatCents).toBe(3500);
    expect(preview.recomputed.outputVatCents).toBe(7000);
    expect(preview.recomputed.inputVatCents).toBe(8500); // 3500 + 5000
    expect(preview.delta.addOutputVatCents).toBe(0);
    expect(preview.delta.addInputVatCents).toBe(5000);
    expect(preview.delta.addNetCents).toBe(-5000); // refund grew
    expect(preview.surcharge.cents).toBe(0); // refund-direction → no surcharge
    expect(preview.surcharge.originalDueDate).toBe('2050-02-15');
    expect(preview.noChange).toBe(false);
    // Blueprint should have Cr 1155 + Dr 1158 (no Dr 2201 since addOutput=0)
    const codes = preview.blueprintLines.map((l) => l.accountCode).sort();
    expect(codes).toEqual(['1155', '1158']);
  });

  it('3. amend executes — superseded row + sequence=1 + delta journal', async () => {
    const result = await amend.amend(
      TEST_YEAR,
      TEST_MONTH,
      { amendmentDate: new Date(Date.UTC(2050, 1, 15)) },
    );
    expect(result.filing.amendmentSequence).toBe(1);
    expect(result.filing.outputVatCents).toBe(7000);
    expect(result.filing.inputVatCents).toBe(8500);
    expect(result.filing.netPayableCents).toBe(-1500); // -฿15 (refund)
    expect(result.surchargeCents).toBe(0);
    expect(result.branch).toBe('more_refund');

    // Old row should be 'amended', new row 'filed'.
    const filed = await getFiling(TEST_YEAR, TEST_MONTH, 'filed');
    const amended = await getFiling(TEST_YEAR, TEST_MONTH, 'amended');
    expect(filed.amendment_sequence).toBe(1);
    expect(amended.amendment_sequence).toBe(0);
    expect(filed.original_filing_id).toBe(amended.id);

    // Closing journal posted — verify lines balance.
    const lines: any[] = await client`
      SELECT account_code, debit_cents, credit_cents
        FROM custom.journal_entry_lines
       WHERE journal_entry_id = ${result.closingJournalId}
       ORDER BY account_code
    `;
    const dr = lines.reduce((s, l) => s + Number(l.debit_cents), 0);
    const cr = lines.reduce((s, l) => s + Number(l.credit_cents), 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(5000); // Cr 1155 5000 / Dr 1158 5000
  });

  it('4. preview when nothing has changed → noChange=true (and amend rejects)', async () => {
    // Without seeding anything new, preview should detect no delta.
    const preview = await amend.preview(
      TEST_YEAR,
      TEST_MONTH,
      new Date(Date.UTC(2050, 1, 16)),
    );
    expect(preview.noChange).toBe(true);
    expect(preview.blueprintLines.length).toBe(0);

    await expect(
      amend.amend(TEST_YEAR, TEST_MONTH, {
        amendmentDate: new Date(Date.UTC(2050, 1, 16)),
      }),
    ).rejects.toThrow(/nothing to amend/i);
  });

  it('5. amend with new sale 5 months late → surcharge applies', async () => {
    // Add a missed sale: ฿2,000 sale, ฿140 VAT. Increases output → more payable.
    await seedOrder({ vatCents: 14_000, totalCents: 214_000 });

    // Amend on 2050-07-16 (5 months and 1 day after due date 2050-02-15 → 6 months late)
    const amendmentDate = new Date(Date.UTC(2050, 6, 16));
    const preview = await amend.preview(TEST_YEAR, TEST_MONTH, amendmentDate);
    expect(preview.delta.addOutputVatCents).toBe(14_000);
    expect(preview.delta.addInputVatCents).toBe(0);
    expect(preview.delta.addNetCents).toBe(14_000);
    expect(preview.surcharge.months).toBe(6);
    expect(preview.surcharge.cents).toBe(Math.floor((14_000 * 150 * 6) / 10_000)); // 1260 satang = ฿12.60
    expect(preview.surcharge.cents).toBe(1260);
    expect(preview.surcharge.cappedAt200pct).toBe(false);

    const result = await amend.amend(TEST_YEAR, TEST_MONTH, { amendmentDate });
    expect(result.filing.amendmentSequence).toBe(2);
    expect(result.filing.netPayableCents).toBe(7000 + 14_000 - 8500); // 12500 = ฿125
    expect(result.surchargeCents).toBe(1260);
    expect(result.branch).toBe('more_payable');

    // Journal: Dr 2201 14_000 / Dr 6390 1260 / Cr 1155 0 (none) / Cr 2210 (14_000+1260=15260)
    const lines: any[] = await client`
      SELECT account_code, debit_cents, credit_cents
        FROM custom.journal_entry_lines
       WHERE journal_entry_id = ${result.closingJournalId}
       ORDER BY account_code
    `;
    const byAccount: Record<string, { dr: number; cr: number }> = {};
    for (const l of lines) {
      byAccount[l.account_code] = {
        dr: Number(l.debit_cents),
        cr: Number(l.credit_cents),
      };
    }
    expect(byAccount['2201']).toEqual({ dr: 14_000, cr: 0 });
    expect(byAccount['6390']).toEqual({ dr: 1260, cr: 0 });
    expect(byAccount['2210']).toEqual({ dr: 0, cr: 14_000 + 1260 });
  });

  it('6. lineage returns the full chronological chain', async () => {
    const lineage = await amend.lineage(TEST_YEAR, TEST_MONTH);
    expect(lineage.length).toBe(3);
    expect(lineage[0].amendmentSequence).toBe(0);
    expect(lineage[0].status).toBe('amended');
    expect(lineage[0].originalFilingId).toBe(null); // root has no parent
    expect(lineage[1].amendmentSequence).toBe(1);
    expect(lineage[1].status).toBe('amended');
    expect(lineage[1].originalFilingId).toBe(lineage[0].id); // points at root
    expect(lineage[2].amendmentSequence).toBe(2);
    expect(lineage[2].status).toBe('filed');
    expect(lineage[2].originalFilingId).toBe(lineage[0].id); // also points at root
    expect(lineage[2].surchargeCents).toBe(1260);
  });

  it('7. partial UNIQUE prevents two filed rows for same period', async () => {
    // Try to insert another 'filed' row for same period — should fail.
    await expect(
      client`
        INSERT INTO custom.pp30_filings (period_year, period_month,
          output_vat_cents, input_vat_cents, net_payable_cents, status, filed_at)
        VALUES (${TEST_YEAR}, ${TEST_MONTH}, 0, 0, 0, 'filed', NOW())
      `,
    ).rejects.toThrow(/duplicate|unique|pp30_period_active_idx/i);
  });

  it('8. preview rejects when no active filing exists for the period', async () => {
    // Use a period that was never closed.
    await expect(amend.preview(TEST_YEAR + 1, 6)).rejects.toThrow(/no active filing/i);
  });
});
