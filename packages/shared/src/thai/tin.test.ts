import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  formatTIN,
  guessTINKind,
  isValidBranchCode,
  isValidTIN,
  normalizeTIN,
  parseTIN,
} from "./tin";

/** Generate a valid 13-digit TIN for property tests. */
function validTIN(leading: "0" | "1" | "2" | "3"): string {
  const base: number[] = [Number(leading)];
  for (let i = 1; i < 12; i += 1) base.push(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += base[i] * (13 - i);
  const checksum = (11 - (sum % 11)) % 10;
  base.push(checksum);
  return base.join("");
}

describe("Thai TIN", () => {
  it("accepts a known-valid TIN", () => {
    // RD sample juristic: 0994000165510
    expect(isValidTIN("0994000165510")).toBe(true);
  });

  it("rejects checksum-corrupt TIN", () => {
    expect(isValidTIN("0994000165511")).toBe(false);
  });

  it("rejects non-13-digit input", () => {
    expect(isValidTIN("12345")).toBe(false);
    expect(isValidTIN("12345678901234")).toBe(false);
    expect(isValidTIN("abcdefghijklm")).toBe(false);
  });

  it("normalizes separators", () => {
    expect(normalizeTIN("0-9940-00165-51-0")).toBe("0994000165510");
    expect(normalizeTIN(" 0994 0001 6551 0 ")).toBe("0994000165510");
  });

  it("validates through dashes and spaces", () => {
    expect(isValidTIN("0-9940-00165-51-0")).toBe(true);
  });

  it("formats to RD display convention", () => {
    expect(formatTIN("0994000165510")).toBe("0-9940-00165-51-0");
  });

  it("parseTIN throws with descriptive errors", () => {
    expect(() => parseTIN("123")).toThrow(/13 digits/);
    expect(() => parseTIN("0994000165511")).toThrow(/checksum/);
    expect(() => parseTIN("0994000165510", "bad")).toThrow(/5 digits/);
  });

  it("defaults branch to 00000 when omitted", () => {
    expect(parseTIN("0994000165510").branch).toBe("00000");
  });

  it("pads partial branch codes", () => {
    expect(parseTIN("0994000165510", "1").branch).toBe("00001");
  });

  it("guesses kind from leading digit", () => {
    expect(guessTINKind("0994000165510")).toBe("juristic");
    expect(guessTINKind("1101500123457")).toBe("citizen");
  });

  it("validates branch code shape", () => {
    expect(isValidBranchCode("00000")).toBe(true);
    expect(isValidBranchCode("99999")).toBe(true);
    expect(isValidBranchCode("0000")).toBe(false);
    expect(isValidBranchCode("abcde")).toBe(false);
  });

  it("property: any generated valid TIN passes isValidTIN", () => {
    // Run 200 trials — generator already satisfies the mod-11 invariant.
    for (let trial = 0; trial < 200; trial += 1) {
      const t = validTIN(trial % 2 === 0 ? "0" : "1");
      expect(isValidTIN(t)).toBe(true);
    }
  });

  it("property: corrupting the final checksum digit always fails", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), (delta) => {
        const good = "0994000165510";
        const mutated = good.slice(0, 12) + String((Number(good[12]) + delta) % 10);
        return mutated === good || isValidTIN(mutated) === false;
      }),
      { numRuns: 50 },
    );
  });
});
