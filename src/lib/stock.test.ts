import { describe, expect, it } from "vitest";
import { stockStatus } from "./stock";
import type { Product } from "../types";

function product(overrides: Partial<Product>): Product {
  return {
    id: 1,
    name: "Test Product",
    barcode: null,
    sku: null,
    category: null,
    manufacturer: null,
    supplier: null,
    strength: null,
    unit: null,
    rx_flag: 0,
    batch_no: null,
    expiry_date: null,
    cost_price: 1,
    selling_price: 2,
    stock_qty: 50,
    reorder_level: 10,
    fda_reg_no: null,
    is_controlled: 0,
    active: 1,
    ...overrides,
  };
}

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("stockStatus", () => {
  it("is critical when out of stock", () => {
    expect(stockStatus(product({ stock_qty: 0 }))).toBe("critical");
  });

  it("is critical when already expired", () => {
    const past = new Date();
    past.setDate(past.getDate() - 5);
    expect(stockStatus(product({ expiry_date: fmt(past) }))).toBe("critical");
  });

  it("is critical when expiring within 30 days (inclusive of today)", () => {
    expect(stockStatus(product({ expiry_date: fmt(new Date()) }))).toBe("critical");
    const soon = new Date();
    soon.setDate(soon.getDate() + 29);
    expect(stockStatus(product({ expiry_date: fmt(soon) }))).toBe("critical");
  });

  it("is low when at or below reorder level but not expiring soon", () => {
    const far = new Date();
    far.setDate(far.getDate() + 200);
    expect(stockStatus(product({ stock_qty: 10, reorder_level: 10, expiry_date: fmt(far) }))).toBe("low");
  });

  it("is in stock when healthy and not near expiry", () => {
    const far = new Date();
    far.setDate(far.getDate() + 200);
    expect(stockStatus(product({ stock_qty: 50, reorder_level: 10, expiry_date: fmt(far) }))).toBe("in");
  });

  it("is in stock when there's no expiry date at all", () => {
    expect(stockStatus(product({ stock_qty: 50, reorder_level: 10, expiry_date: null }))).toBe("in");
  });
});
