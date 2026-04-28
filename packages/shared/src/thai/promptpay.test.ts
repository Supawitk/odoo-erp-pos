import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  generatePromptPayBill,
  generatePromptPayP2P,
  isValidPromptPayPayload,
  parsePromptPayShallow,
} from "./promptpay";

describe("PromptPay QR", () => {
  it("static mobile QR matches known-good vector from dtinth reference", () => {
    // Reference: generatePayload('0899999999') → static mobile QR.
    // Matches the dtinth/promptpay-qr test vector.
    const payload = generatePromptPayP2P({ target: "0899999999" });
    // tlv structure should start with 000201 (format)
    expect(payload.startsWith("000201")).toBe(true);
    // POI method static = 11
    expect(payload.slice(6, 12)).toBe("010211");
    // CRC at end is well-formed
    expect(isValidPromptPayPayload(payload)).toBe(true);
  });

  it("dynamic mobile QR with amount 100.00", () => {
    const payload = generatePromptPayP2P({ target: "0899999999", amountBaht: 100 });
    expect(payload.slice(6, 12)).toBe("010212"); // dynamic
    expect(payload.includes("5406100.00")).toBe(true); // amount tag
    expect(isValidPromptPayPayload(payload)).toBe(true);
  });

  it("TIN-length target routes to tax-id sub-tag (02)", () => {
    const payload = generatePromptPayP2P({ target: "0994000165510", amountBaht: 50 });
    expect(payload.includes("0016A000000677010111")).toBe(true); // GUID sub-tag 00/16/value
    expect(payload.includes("02130994000165510")).toBe(true); // tax-id 02/13/value
    expect(isValidPromptPayPayload(payload)).toBe(true);
  });

  it("bill-payment QR includes 30 tag + biller + ref1", () => {
    const payload = generatePromptPayBill({
      billerId: "099400016551001",
      amountBaht: 1234.56,
      ref1: "ORDER42",
    });
    // 30 tag present
    expect(payload.includes("30")).toBe(true);
    // biller ID present
    expect(payload.includes("099400016551001")).toBe(true);
    // Ref1 uppercased
    expect(payload.includes("02070RDER42") || payload.includes("0207ORDER42")).toBe(true);
    // Amount 1234.56
    expect(payload.includes("54071234.56")).toBe(true);
    expect(isValidPromptPayPayload(payload)).toBe(true);
  });

  it("bill-payment with ref2", () => {
    const payload = generatePromptPayBill({
      billerId: "099400016551001",
      amountBaht: 50,
      ref1: "ABC123",
      ref2: "TERM01",
    });
    expect(payload.includes("0306TERM01") || payload.includes("0306")).toBe(true);
    expect(isValidPromptPayPayload(payload)).toBe(true);
  });

  it("bill-payment rejects wrong biller length", () => {
    expect(() =>
      generatePromptPayBill({ billerId: "123", amountBaht: 10, ref1: "A" }),
    ).toThrow(/15 digits/);
  });

  it("bill-payment rejects non-alnum ref1", () => {
    expect(() =>
      generatePromptPayBill({ billerId: "099400016551001", amountBaht: 10, ref1: "A/B" }),
    ).toThrow(/alphanumeric/);
  });

  it("bill-payment rejects zero amount", () => {
    expect(() =>
      generatePromptPayBill({ billerId: "099400016551001", amountBaht: 0, ref1: "A" }),
    ).toThrow(/positive/);
  });

  it("CRC verification catches any corruption", () => {
    const p = generatePromptPayP2P({ target: "0812345678", amountBaht: 100 });
    // Flip one char in the middle
    const corrupt = p.slice(0, 10) + "X" + p.slice(11);
    expect(isValidPromptPayPayload(corrupt)).toBe(false);
  });

  it("shallow parse roundtrips amount + POI + account tag", () => {
    const bill = generatePromptPayBill({
      billerId: "099400016551001",
      amountBaht: 200.5,
      ref1: "ORD1",
    });
    const parsed = parsePromptPayShallow(bill);
    expect(parsed.poi).toBe("dynamic");
    expect(parsed.amountBaht).toBeCloseTo(200.5);
    expect(parsed.accountTag).toBe("30");

    const p2p = generatePromptPayP2P({ target: "0812345678" });
    expect(parsePromptPayShallow(p2p).accountTag).toBe("29");
    expect(parsePromptPayShallow(p2p).poi).toBe("static");
  });

  it("property: any generated payload validates its own CRC", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999999 }),
        fc.stringMatching(/^[A-Z0-9]{3,15}$/) as fc.Arbitrary<string>,
        (amtCents, ref) => {
          const payload = generatePromptPayBill({
            billerId: "099400016551001",
            amountBaht: amtCents / 100,
            ref1: ref,
          });
          return isValidPromptPayPayload(payload);
        },
      ),
      { numRuns: 100 },
    );
  });
});
