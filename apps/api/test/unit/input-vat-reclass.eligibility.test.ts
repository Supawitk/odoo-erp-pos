import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateReclassEligibility,
  addMonthsIso,
  daysBetweenIso,
} from '../../src/modules/reports/input-vat-reclass.eligibility';

describe('Input VAT reclass eligibility (§82/3 6-month window)', () => {
  // ─── Happy path ──────────────────────────────────────────────────────
  it('eligible when posted, has VAT, not reclassed, past 6 months', () => {
    const r = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-15',
      inputVatReclassedAt: null,
      asOf: '2025-08-01',
    });
    expect(r.eligible).toBe(true);
    expect(r.taxPointDate).toBe('2025-01-15');
    expect(r.claimDeadline).toBe('2025-07-15');
    expect(r.daysOverdue).toBeGreaterThan(0);
  });

  it('eligible for paid bill (1155 was debited at post)', () => {
    const r = evaluateReclassEligibility({
      status: 'paid',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: null,
      inputVatReclassedAt: null,
      asOf: '2026-01-02',
    });
    expect(r.eligible).toBe(true);
    expect(r.taxPointDate).toBe('2025-01-01'); // fell back to bill_date
  });

  it('eligible for partially_paid bill', () => {
    const r = evaluateReclassEligibility({
      status: 'partially_paid',
      vatCents: 1000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-01',
      inputVatReclassedAt: null,
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(true);
  });

  // ─── Rejections ──────────────────────────────────────────────────────
  it('rejects draft bills — they were never posted', () => {
    const r = evaluateReclassEligibility({
      status: 'draft',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-01',
      inputVatReclassedAt: null,
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('BILL_NOT_POSTED');
  });

  it('rejects voided bills', () => {
    const r = evaluateReclassEligibility({
      status: 'void',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-01',
      inputVatReclassedAt: null,
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('BILL_VOIDED');
  });

  it('rejects bills with no VAT', () => {
    const r = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 0,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-01',
      inputVatReclassedAt: null,
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('NO_INPUT_VAT');
  });

  it('rejects bills already claimed via PP.30 close', () => {
    // Bill is past 6mo AND posted, BUT pp30_filing_id is set → 1155 share
    // already moved to 2210/1158 at close; reclass would double-credit.
    const r = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-15',
      inputVatReclassedAt: null,
      pp30FilingId: '00000000-0000-0000-0000-000000000001',
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('ALREADY_PP30_CLAIMED');
  });

  it('rejects already-reclassed bills (idempotency)', () => {
    const r = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 7000,
      billDate: '2025-01-01',
      supplierTaxInvoiceDate: '2025-01-01',
      inputVatReclassedAt: new Date('2025-08-01'),
      asOf: '2026-01-01',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('ALREADY_RECLASSED');
  });

  it('rejects bills still inside the 6-month window', () => {
    // tax-point Jan 15 → deadline Jul 15. asOf Jul 15 = boundary, NOT eligible.
    const r = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 7000,
      billDate: '2025-01-15',
      supplierTaxInvoiceDate: '2025-01-15',
      inputVatReclassedAt: null,
      asOf: '2025-07-15',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('WITHIN_6MONTHS');

    // asOf Jul 16 = day after boundary, IS eligible.
    const r2 = evaluateReclassEligibility({
      status: 'posted',
      vatCents: 7000,
      billDate: '2025-01-15',
      supplierTaxInvoiceDate: '2025-01-15',
      inputVatReclassedAt: null,
      asOf: '2025-07-16',
    });
    expect(r2.eligible).toBe(true);
    expect(r2.daysOverdue).toBe(1);
  });

  // ─── Date arithmetic edge cases ───────────────────────────────────────
  it('addMonthsIso handles month-end overflow (Jan 31 + 1mo = Feb 28)', () => {
    expect(addMonthsIso('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonthsIso('2024-01-31', 1)).toBe('2024-02-29'); // leap
    expect(addMonthsIso('2025-08-31', 6)).toBe('2026-02-28');
  });

  it('addMonthsIso handles year wraparound', () => {
    expect(addMonthsIso('2025-09-15', 6)).toBe('2026-03-15');
    expect(addMonthsIso('2025-12-31', 1)).toBe('2026-01-31');
  });

  // ─── Property: any past deadline is eligible if all other gates clear ──
  it('property — eligibility flips precisely on day after deadline', () => {
    // Generate days-since-2020-01-01 to avoid fast-check 4.x generating Date(NaN).
    const BASE = new Date('2020-01-01T00:00:00Z').getTime();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3650 }), // ~10 years
        (offsetDays) => {
          const taxPoint = new Date(BASE + offsetDays * 86400000);
          const tpIso = taxPoint.toISOString().slice(0, 10);
          const deadline = addMonthsIso(tpIso, 6);
          const onDeadline = evaluateReclassEligibility({
            status: 'posted',
            vatCents: 1,
            billDate: tpIso,
            supplierTaxInvoiceDate: tpIso,
            inputVatReclassedAt: null,
            asOf: deadline,
          });
          // Day after deadline
          const next = new Date(`${deadline}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          const dayAfter = next.toISOString().slice(0, 10);
          const past = evaluateReclassEligibility({
            status: 'posted',
            vatCents: 1,
            billDate: tpIso,
            supplierTaxInvoiceDate: tpIso,
            inputVatReclassedAt: null,
            asOf: dayAfter,
          });
          expect(onDeadline.eligible).toBe(false);
          expect(past.eligible).toBe(true);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('daysBetweenIso is symmetric and zero-on-same-day', () => {
    expect(daysBetweenIso('2025-04-01', '2025-04-01')).toBe(0);
    expect(daysBetweenIso('2025-04-01', '2025-04-30')).toBe(29);
  });
});
