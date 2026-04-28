import { describe, it, expect } from "vitest";
import { applyDiscounts } from "./discount";

describe("applyDiscounts", () => {
  it("line-percent reduces one line only", () => {
    const { perLineNet, totalDiscount } = applyDiscounts(
      [
        { id: "a", subtotalCents: 1000 },
        { id: "b", subtotalCents: 2000 },
      ],
      [{ id: "d1", kind: "line-percent", value: 0.1, lineId: "a" }],
    );
    expect(perLineNet.get("a")!.toCents()).toBe(900);
    expect(perLineNet.get("b")!.toCents()).toBe(2000);
    expect(totalDiscount.toCents()).toBe(100);
  });

  it("cart-monetary prorates across lines by current net", () => {
    // cart total = 3000, discount 300 (10%). Lines get allocated by ratio.
    const { perLineNet, totalDiscount } = applyDiscounts(
      [
        { id: "a", subtotalCents: 1000 },
        { id: "b", subtotalCents: 2000 },
      ],
      [{ id: "d1", kind: "cart-monetary", value: 300 }],
    );
    const sum = perLineNet.get("a")!.toCents() + perLineNet.get("b")!.toCents();
    expect(sum).toBe(2700);
    expect(totalDiscount.toCents()).toBe(300);
  });

  it("priority order: line-monetary before line-percent before cart", () => {
    // Line A: 1000 -> line-monetary 100 = 900 -> line-percent 10% = 810
    // Then cart-percent 10% on total = 810+2000=2810 * 0.9 = 2529 (prorated)
    const { totalDiscount } = applyDiscounts(
      [
        { id: "a", subtotalCents: 1000 },
        { id: "b", subtotalCents: 2000 },
      ],
      [
        { id: "d3", kind: "cart-percent", value: 0.1 },
        { id: "d2", kind: "line-percent", value: 0.1, lineId: "a" },
        { id: "d1", kind: "line-monetary", value: 100, lineId: "a" },
      ],
    );
    expect(totalDiscount.toCents()).toBe(3000 - 2529);
  });

  it("line net can never go below zero", () => {
    const { perLineNet } = applyDiscounts(
      [{ id: "a", subtotalCents: 100 }],
      [{ id: "d1", kind: "line-monetary", value: 9999, lineId: "a" }],
    );
    expect(perLineNet.get("a")!.toCents()).toBe(0);
  });

  it("cart-monetary clamped to cart total", () => {
    const { perLineNet, totalDiscount } = applyDiscounts(
      [{ id: "a", subtotalCents: 100 }],
      [{ id: "d1", kind: "cart-monetary", value: 5000 }],
    );
    expect(perLineNet.get("a")!.toCents()).toBe(0);
    expect(totalDiscount.toCents()).toBe(100);
  });
});
