import { describe, expect, it } from "vitest";
import { lineTotal, netUnitCost, orderTotal, profitMarginPct, round2 } from "./price";

describe("netUnitCost", () => {
  it("applies a percentage discount to the raw cost", () => {
    expect(netUnitCost(100, 10)).toBeCloseTo(90);
  });
  it("treats a missing discount as zero", () => {
    expect(netUnitCost(50, 0)).toBe(50);
  });
});

describe("lineTotal", () => {
  it("multiplies quantity by net unit cost", () => {
    expect(lineTotal(3, 12.5)).toBeCloseTo(37.5);
  });
});

describe("profitMarginPct", () => {
  it("computes margin on selling price", () => {
    expect(profitMarginPct(20, 15)).toBeCloseTo(25);
  });
  it("is null when selling price is zero (undefined margin)", () => {
    expect(profitMarginPct(0, 10)).toBeNull();
  });
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(19.995)).toBe(20);
    expect(round2(4.444)).toBe(4.44);
  });
});

describe("orderTotal", () => {
  const lines = [{ line_total: 100 }, { line_total: 50 }];

  it("returns the subtotal when there's no discount", () => {
    expect(orderTotal(lines, "None", 0)).toBe(150);
  });

  it("subtracts a fixed discount, never going below zero", () => {
    expect(orderTotal(lines, "Fixed", 40)).toBe(110);
    expect(orderTotal(lines, "Fixed", 1000)).toBe(0);
  });

  it("applies a percentage discount", () => {
    expect(orderTotal(lines, "Percentage", 10)).toBeCloseTo(135);
  });

  // PUL-004: a discount over 100% must not produce a negative total — this
  // is the fix for the bug where PurchaseModal could show a negative net
  // total with no warning.
  it("clamps a percentage discount over 100% to zero, not negative", () => {
    expect(orderTotal(lines, "Percentage", 150)).toBe(0);
  });

  it("clamps at exactly 100%", () => {
    expect(orderTotal(lines, "Percentage", 100)).toBe(0);
  });
});
