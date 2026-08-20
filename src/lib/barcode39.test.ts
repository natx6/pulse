import { describe, expect, it } from "vitest";
import { code39Bars, code39Valid, code39Width } from "./barcode39";

describe("code39Valid", () => {
  it("accepts digits, letters, and the supported symbol set", () => {
    expect(code39Valid("6220000000011")).toBe(true);
    expect(code39Valid("ABC-123")).toBe(true);
    expect(code39Valid("a b c")).toBe(true); // lowercase + space, normalized
  });

  it("rejects an empty or whitespace-only code", () => {
    expect(code39Valid("")).toBe(false);
    expect(code39Valid("   ")).toBe(false);
  });

  it("rejects characters outside the Code39 set", () => {
    expect(code39Valid("ABC#123")).toBe(false);
    expect(code39Valid("héllo")).toBe(false);
  });
});

describe("code39Bars / code39Width", () => {
  it("still encodes the start/stop markers for an empty code", () => {
    expect(code39Width("")).toBeGreaterThan(0);
  });

  it("produces the same width for the same input", () => {
    const a = code39Width("PULSE1");
    const b = code39Width("PULSE1");
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("a code with any invalid character is not fully encodable", () => {
    // This is the exact gap PUL-027 flagged: code39Bars silently drops
    // unsupported characters instead of failing, so callers must check
    // code39Valid() first rather than trusting a non-zero width.
    const mixed = "ABC#123";
    expect(code39Valid(mixed)).toBe(false);
    // The encoder still produces *something* for the valid characters —
    // proving why a width-only check would wrongly allow printing this.
    expect(code39Width(mixed)).toBeGreaterThan(0);
  });

  it("bars are non-overlapping and increase in x position", () => {
    const bars = code39Bars("A1");
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    }
  });
});
