import { describe, expect, it } from "vitest";
import { bahtText, bahtTextFromSatang } from "./baht-text";

describe("bahtText", () => {
  it.each([
    [0, "ศูนย์บาทถ้วน"],
    [1, "หนึ่งบาทถ้วน"],
    [2, "สองบาทถ้วน"],
    [10, "สิบบาทถ้วน"],
    [11, "สิบเอ็ดบาทถ้วน"],
    [20, "ยี่สิบบาทถ้วน"],
    [21, "ยี่สิบเอ็ดบาทถ้วน"],
    [22, "ยี่สิบสองบาทถ้วน"],
    [100, "หนึ่งร้อยบาทถ้วน"],
    [101, "หนึ่งร้อยเอ็ดบาทถ้วน"],
    [111, "หนึ่งร้อยสิบเอ็ดบาทถ้วน"],
    [1000, "หนึ่งพันบาทถ้วน"],
    [10000, "หนึ่งหมื่นบาทถ้วน"],
    [100000, "หนึ่งแสนบาทถ้วน"],
    [1000000, "หนึ่งล้านบาทถ้วน"],
    [2000000, "สองล้านบาทถ้วน"],
    [1234567, "หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ดบาทถ้วน"],
  ])("%d → %s", (n, expected) => {
    expect(bahtText(n)).toBe(expected);
  });

  it("0.50 → ห้าสิบสตางค์", () => {
    expect(bahtText(0.5)).toBe("ศูนย์บาทห้าสิบสตางค์");
  });

  it("1.25 → หนึ่งบาทยี่สิบห้าสตางค์", () => {
    expect(bahtText(1.25)).toBe("หนึ่งบาทยี่สิบห้าสตางค์");
  });

  it("1234.56 → full form", () => {
    expect(bahtText(1234.56)).toBe(
      "หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบหกสตางค์",
    );
  });

  it("negative amounts prefix ลบ", () => {
    expect(bahtText(-500)).toBe("ลบห้าร้อยบาทถ้วน");
  });

  it("bahtTextFromSatang matches bahtText of the decimal equivalent", () => {
    expect(bahtTextFromSatang(12345)).toBe(bahtText(123.45));
    expect(bahtTextFromSatang(100)).toBe(bahtText(1));
    expect(bahtTextFromSatang(50)).toBe(bahtText(0.5));
  });

  it("throws on non-finite", () => {
    expect(() => bahtText(Number.NaN)).toThrow();
    expect(() => bahtText(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("throws on non-integer satang", () => {
    expect(() => bahtTextFromSatang(1.5)).toThrow(/integer/);
  });
});
