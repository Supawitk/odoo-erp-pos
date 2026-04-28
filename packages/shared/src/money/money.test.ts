import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Money } from "./money";

describe("Money value object", () => {
  describe("construction", () => {
    it("rejects non-integer cents", () => {
      expect(() => Money.ofCents(1.5, "USD")).toThrow();
    });

    it("ofCents / toCents round-trips", () => {
      expect(Money.ofCents(1234, "USD").toCents()).toBe(1234);
    });

    it("fromDecimal uses currency scale", () => {
      expect(Money.fromDecimal(12.34, "USD").toCents()).toBe(1234);
      expect(Money.fromDecimal(1234, "JPY").toCents()).toBe(1234);
    });
  });

  describe("arithmetic invariants (fast-check)", () => {
    it("addition is commutative", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 99_999_999 }),
          fc.integer({ min: 0, max: 99_999_999 }),
          (a, b) => {
            const x = Money.ofCents(a, "USD");
            const y = Money.ofCents(b, "USD");
            expect(x.add(y).equals(y.add(x))).toBe(true);
          },
        ),
      );
    });

    it("add/subtract inverse", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 99_999_999 }),
          fc.integer({ min: 0, max: 99_999_999 }),
          (a, b) => {
            const x = Money.ofCents(a, "USD");
            const y = Money.ofCents(b, "USD");
            expect(x.add(y).subtract(y).equals(x)).toBe(true);
          },
        ),
      );
    });

    it("allocate never loses or creates cents (sum == original)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 99_999_999 }),
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 20 }),
          (cents, ratios) => {
            const total = Money.ofCents(cents, "USD");
            const parts = total.allocate(ratios);
            const sum = parts.reduce((a, b) => a.add(b));
            expect(sum.equals(total)).toBe(true);
          },
        ),
      );
    });
  });

  describe("currency safety", () => {
    it("rejects mixed-currency addition", () => {
      const usd = Money.ofCents(100, "USD");
      const eur = Money.ofCents(100, "EUR");
      expect(() => usd.add(eur)).toThrow(/Currency mismatch/);
    });
  });
});
