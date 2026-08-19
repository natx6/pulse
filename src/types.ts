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
}

export interface CartLine {
  productId: number;
  name: string;
  unit: string | null;
  unitPrice: number;
  qty: number;
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

export type PageId = "pos" | "inventory" | "restock" | "analytics" | "support" | "settings" | "expenses";

export interface SaleResult {
  receipt_no: string;
  sale_id: number;
  total: number;
  change: number;
}

export interface Patient {
  name: string;
  phone: string;
}
