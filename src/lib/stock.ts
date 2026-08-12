import type { Product } from "../types";

export type StockStatus = "in" | "low" | "critical";

/** Green: stock > reorder. Yellow: stock <= reorder. Red: stock 0, expired, or expiring within 30 days. */
export function stockStatus(p: Product): StockStatus {
  if (p.stock_qty <= 0) return "critical";
  if (p.expiry_date) {
    const d = new Date(p.expiry_date + "T00:00:00");
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 30);
    if (!Number.isNaN(d.getTime()) && d <= horizon) return "critical";
  }
  if (p.stock_qty <= p.reorder_level) return "low";
  return "in";
}
