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

  it("a code with any invalid character throws instead of mis-encoding", () => {
    // PUL-027's original gap: the encoder used to silently drop unsupported
    // characters, printing a barcode that scans as different data. It now
    // refuses — callers gate with code39Valid() before ever reaching here.
    const mixed = "ABC#123";
    expect(code39Valid(mixed)).toBe(false);
    expect(() => code39Bars(mixed)).toThrow(/cannot encode/);
    expect(() => code39Width(mixed)).toThrow();
  });

  it("bars are non-overlapping and increase in x position", () => {
    const bars = code39Bars("A1");
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    }
  });
});
