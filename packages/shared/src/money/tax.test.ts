import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateTax, stripInclusiveTax } from "./tax";

describe("calculateTax", () => {
  it("exclusive: tax = subtotal * rate", () => {
    const { totalTax, perLineTax } = calculateTax(
      [{ id: "a", subtotalCents: 10_000 }],
      0.1,
      "exclusive",
    );
    expect(totalTax.toCents()).toBe(1_000);
    expect(perLineTax.get("a")!.toCents()).toBe(1_000);
  });

  it("inclusive: tax = gross * rate / (1+rate)", () => {
    // 11000 gross @ 10% inclusive -> 1000 tax, 10000 net
    const { totalTax } = calculateTax(
      [{ id: "a", subtotalCents: 11_000 }],
      0.1,
      "inclusive",
    );
    expect(totalTax.toCents()).toBe(1_000);
  });

  it("multi-line exclusive tax sums correctly", () => {
    const { totalTax } = calculateTax(
      [
        { id: "a", subtotalCents: 1000 },
        { id: "b", subtotalCents: 2500 },
        { id: "c", subtotalCents: 750 },
      ],
      0.08,
    );
    // 80 + 200 + 60 = 340
    expect(totalTax.toCents()).toBe(340);
  });

  it("stripInclusiveTax inverts inclusive tax", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000_000 }),
        fc.double({ min: 0.001, max: 0.3, noNaN: true }),
        (gross, rate) => {
          const { net, tax } = stripInclusiveTax(gross, rate);
          expect(net.toCents() + tax.toCents()).toBe(gross);
          expect(net.toCents()).toBeGreaterThanOrEqual(0);
          expect(tax.toCents()).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
