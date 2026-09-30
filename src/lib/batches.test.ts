import { describe, expect, it } from "vitest";
import {
  allocatePick,
  formatBatchBreakdown,
  formatExpiryDate,
  isExpired,
  parseBatchBreakdown,
} from "./batches";

describe("formatExpiryDate", () => {
  it("renders 15 Mar 2027", () => {
    expect(formatExpiryDate("2027-03-15")).toBe("15 Mar 2027");
  });
  it("passes garbage through", () => {
    expect(formatExpiryDate("soon")).toBe("soon");
  });
});

describe("isExpired", () => {
  it("flags the past, clears the future", () => {
    expect(isExpired("2000-01-01")).toBe(true);
    expect(isExpired("2999-12-31")).toBe(false);
  });
  it("ignores blank/garbage", () => {
    expect(isExpired("")).toBe(false);
    expect(isExpired("no-date")).toBe(false);
  });
});

describe("parseBatchBreakdown", () => {
  it("splits batch@date x qty triples", () => {
    expect(parseBatchBreakdown("AX8821@2027-03-15x2;CT-2301x1")).toEqual([
      { batch: "AX8821", expiry: "2027-03-15", qty: 2 },
      { batch: "CT-2301", expiry: "", qty: 1 },
    ]);
  });
  it("skips junk segments", () => {
    expect(parseBatchBreakdown(";;nonsense;Ax1")).toEqual([{ batch: "A", expiry: "", qty: 1 }]);
  });
});

describe("formatBatchBreakdown", () => {
  it("renders a worker-readable pick string", () => {
    expect(formatBatchBreakdown("AX8821@2027-03-15x2;CT-2301x1")).toBe(
      "AX8821 exp 15 Mar 2027 x2 + CT-2301 x1",
    );
  });
  it("is ASCII-only for thermal printers", () => {
    const s = formatBatchBreakdown("B@2030-01-01x1");
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7E]*$/.test(s)).toBe(true);
  });
});

describe("allocatePick", () => {
  const rows = [
    { id: 1, batch_no: "OLD", expiry_date: "2026-01-01", quantity: 2 },
    { id: 2, batch_no: "NEW", expiry_date: "2028-01-01", quantity: 10 },
  ];
  it("takes oldest first, spanning batches", () => {
    expect(allocatePick(rows, 5)).toEqual([
      { batch: "OLD", expiry: "2026-01-01", qty: 2 },
      { batch: "NEW", expiry: "2028-01-01", qty: 3 },
    ]);
  });
  it("skips empty rows", () => {
    expect(allocatePick([{ id: 3, batch_no: "Z", expiry_date: "", quantity: 0 }, ...rows], 1)).toEqual([
      { batch: "OLD", expiry: "2026-01-01", qty: 1 },
    ]);
  });
});
