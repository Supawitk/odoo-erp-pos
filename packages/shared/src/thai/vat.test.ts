import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  THAI_VAT_STANDARD_RATE,
  assertThaiVatConsistent,
  computeThaiVat,
} from "./vat";

describe("Thai VAT engine", () => {
  it("standard rate is 7%", () => {
    expect(THAI_VAT_STANDARD_RATE).toBeCloseTo(0.07);
  });

  it("exclusive 100 THB at 7% → net 100, vat 7, gross 107", () => {
    const r = computeThaiVat([{ id: "a", amountCents: 10000, category: "standard" }]);
    expect(r.taxableNetCents).toBe(10000);
    expect(r.vatCents).toBe(700);
    expect(r.grossCents).toBe(10700);
    assertThaiVatConsistent(r);
  });

  it("inclusive 107 THB at 7% → net 100, vat 7, gross 107", () => {
    const r = computeThaiVat(
      [{ id: "a", amountCents: 10700, category: "standard" }],
      { defaultMode: "inclusive" },
    );
    expect(r.taxableNetCents).toBe(10000);
    expect(r.vatCents).toBe(700);
    expect(r.grossCents).toBe(10700);
    assertThaiVatConsistent(r);
  });

  it("zero-rated line: 0 vat, net still counted", () => {
    const r = computeThaiVat([{ id: "x", amountCents: 50000, category: "zero_rated" }]);
    expect(r.zeroRatedNetCents).toBe(50000);
    expect(r.taxableNetCents).toBe(0);
    expect(r.vatCents).toBe(0);
    expect(r.grossCents).toBe(50000);
  });

  it("exempt line: 0 vat, isolated bucket", () => {
    const r = computeThaiVat([{ id: "e", amountCents: 30000, category: "exempt" }]);
    expect(r.exemptNetCents).toBe(30000);
    expect(r.taxableNetCents).toBe(0);
    expect(r.zeroRatedNetCents).toBe(0);
    expect(r.vatCents).toBe(0);
  });

  it("mixed basket: standard + zero-rated + exempt", () => {
    const r = computeThaiVat([
      { id: "a", amountCents: 10000, category: "standard" }, // 100 THB
      { id: "b", amountCents: 5000, category: "zero_rated" }, // 50 THB export
      { id: "c", amountCents: 3000, category: "exempt" }, // 30 THB textbook
    ]);
    expect(r.taxableNetCents).toBe(10000);
    expect(r.zeroRatedNetCents).toBe(5000);
    expect(r.exemptNetCents).toBe(3000);
    expect(r.vatCents).toBe(700);
    expect(r.grossCents).toBe(18700);
    assertThaiVatConsistent(r);
  });

  it("per-line override of rate (e.g. tourism 5% special scheme)", () => {
    const r = computeThaiVat([
      { id: "a", amountCents: 10000, category: "standard", rate: 0.05 },
    ]);
    expect(r.vatCents).toBe(500);
  });

  it("per-line override of mode (exclusive default, inclusive one line)", () => {
    const r = computeThaiVat([
      { id: "a", amountCents: 10000, category: "standard" }, // exclusive
      { id: "b", amountCents: 10700, category: "standard", mode: "inclusive" }, // inclusive
    ]);
    expect(r.taxableNetCents).toBe(20000);
    expect(r.vatCents).toBe(1400);
    expect(r.grossCents).toBe(21400);
  });

  it("property: exclusive/inclusive are inverses", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (netCents) => {
        const excl = computeThaiVat([{ id: "a", amountCents: netCents, category: "standard" }]);
        const incl = computeThaiVat(
          [{ id: "a", amountCents: excl.grossCents, category: "standard" }],
          { defaultMode: "inclusive" },
        );
        // Round-trip through inclusive may shift by at most 1 satang due to the
        // Math.round at each step — this is the documented tolerance.
        expect(Math.abs(incl.taxableNetCents - netCents)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it("property: invariants hold for arbitrary baskets", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 10_000_000 }),
            cat: fc.constantFrom("standard", "zero_rated", "exempt") as fc.Arbitrary<
              "standard" | "zero_rated" | "exempt"
            >,
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (rows) => {
          const r = computeThaiVat(
            rows.map((row, i) => ({
              id: String(i),
              amountCents: row.amount,
              category: row.cat,
            })),
          );
          assertThaiVatConsistent(r);
        },
      ),
      { numRuns: 100 },
    );
  });
});
