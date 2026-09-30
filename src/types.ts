export interface Product {
  id: number;
  name: string;
  barcode: string | null;
  sku: string | null;
  category: string | null;
  manufacturer: string | null;
  supplier: string | null;
  strength: string | null;
  unit: string | null;
  dosage_form?: string | null;
  route?: string | null;
  rx_flag: number;
  batch_no: string | null;
  expiry_date: string | null;
  cost_price: number;
  selling_price: number;
  stock_qty: number;
  reorder_level: number;
  fda_reg_no: string | null;
  is_controlled: number;
  active: number;
  generic_name?: string | null;
  active_ingredient?: string | null;
  /** Sell units per purchase pack (carton of 10 strips = 10). 1 = none. */
  pack_size?: number;
}

/** One batch row of a product (the FEFO ledger behind stock_qty). */
export interface BatchRow {
  id: number;
  batch_no: string | null;
  expiry_date: string | null;
  quantity: number;
}

export interface CartLine {
  productId: number;
  name: string;
  unit: string | null;
  unitPrice: number;
  qty: number;
  /** FEFO breakdown recorded at sale time ("AX-8821@2027-03-15x2;B15x1").
   * Present on receipt/reprint lines so the handover is checkable. */
  batches?: string | null;
}

export interface SaleLine {
  product_id: number;
  name: string;
  quantity: number;
  unit_price: number;
  unit: string | null;
}

export interface PaymentLine {
  method: PaymentMethod;
  amount: number;
  reference: string | null;
}

export type PaymentMethod = "Cash" | "Card" | "MoMo" | "Credit";

export type PageId = "dashboard" | "pos" | "inventory" | "restock" | "analytics" | "support" | "settings" | "expenses" | "history" | "customers";

/** Staff role. Owner/manager run the business; MCA (Medicine Counter
 * Assistant) works the counter with scoped access (own reports, theme-only
 * settings, add-only expenses). */
export type Role = "owner" | "manager" | "mca";

export interface SaleResult {
  receipt_no: string;
  sale_id: number;
  total: number;
  change: number;
  /** Per-line FEFO breakdowns actually deducted, same order as lines sent in. */
  line_batches: { product_id: number; batches: string }[];
}

export interface Patient {
  name: string;
  phone: string;
}
