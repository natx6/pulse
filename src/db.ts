import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { PaymentLine, Product, SaleLine, SaleResult } from "./types";

let db: Database | null = null;

/**
 * Relative on purpose: must be the EXACT string the Rust side registered
 * migrations under ("sqlite:pulse.db"). tauri-plugin-sql resolves relative
 * sqlite paths against the app data dir on both sides, so the file is the
 * same one the atomic sale command writes to.
 */
export function dbUrl(): string {
  return "sqlite:pulse.db";
}

export async function initDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load(dbUrl());
  try {
    await db.select("PRAGMA journal_mode=WAL;");
  } catch {
    // WAL is an optimization — non-fatal if unavailable
  }
  await seedSettings();
  return db;
}

async function seedSettings() {
  const d = await initDb();
  const rows = await d.select<{ key: string }[]>("SELECT key FROM settings");
  const have = new Set(rows.map((r) => r.key));
  const defaults: Record<string, string> = {
    pharmacy_name: "Pulse Pharmacy",
    tax_rate: "0",
    operator: "",
    receipt_footer: "Thank you. Get well soon.",
    auto_operator: "0",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!have.has(k)) {
      await d.execute("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, v]);
    }
  }
}

export interface AppSettings {
  pharmacyName: string;
  taxRate: number;
  operator: string;
  receiptFooter: string;
  autoOperator: boolean;
}

export async function getSettings(): Promise<AppSettings> {
  const d = await initDb();
  const rows = await d.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings",
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    pharmacyName: map.pharmacy_name ?? "Pulse Pharmacy",
    taxRate: Number(map.tax_rate ?? 0),
    operator: map.operator ?? "",
    receiptFooter: map.receipt_footer ?? "",
    autoOperator: map.auto_operator === "1",
  };
}

export async function saveSetting(key: string, value: string) {
  const d = await initDb();
  await d.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export interface Operator {
  id: number;
  name: string;
  shift_start: string | null;
  shift_end: string | null;
}

export async function loadOperators(): Promise<Operator[]> {
  const d = await initDb();
  return await d.select<Operator[]>(
    "SELECT id, name, shift_start, shift_end FROM operators ORDER BY name",
  );
}

export async function saveOperator(op: {
  name: string;
  shift_start: string | null;
  shift_end: string | null;
}): Promise<void> {
  const d = await initDb();
  await d.execute(
    "INSERT INTO operators (name, shift_start, shift_end) VALUES ($1, $2, $3)",
    [op.name.trim(), op.shift_start, op.shift_end],
  );
}

export async function deleteOperator(id: number): Promise<void> {
  const d = await initDb();
  await d.execute("DELETE FROM operators WHERE id = $1", [id]);
}

export async function loadProducts(): Promise<Product[]> {
  const d = await initDb();
  const rows = await d.select<Product[]>(
    "SELECT * FROM products WHERE active = 1 ORDER BY name",
  );
  return rows.map((r) => ({
    ...r,
    cost_price: Number(r.cost_price),
    selling_price: Number(r.selling_price),
  }));
}

/** All products including archived (Inventory's "Show archived" toggle). */
export async function loadProductsAll(): Promise<Product[]> {
  const d = await initDb();
  const rows = await d.select<Product[]>("SELECT * FROM products ORDER BY name");
  return rows.map((r) => ({
    ...r,
    cost_price: Number(r.cost_price),
    selling_price: Number(r.selling_price),
  }));
}

/** Archive (0) or restore (1) a product. Archived items leave the POS and
 * inventory lists but keep their sales history. */
export async function setProductActive(id: number, active: number): Promise<void> {
  const d = await initDb();
  await d.execute("UPDATE products SET active = $1 WHERE id = $2", [active, id]);
}

export interface IntakeInput {
  barcode: string | null;
  name: string;
  quantity: number;
  costPrice: number | null;
  sellingPrice: number;
  batchNo: string | null;
  expiryDate: string | null;
  supplier: string | null;
  manufacturer: string | null;
  category: string | null;
  unit: string | null;
}

/** Restock: update existing product by barcode (adds qty) or create a new one. Returns {id, created}. */
export async function intakeStock(input: IntakeInput): Promise<{ id: number; created: boolean }> {
  const d = await initDb();
  if (input.barcode) {
    const existing = await d.select<Product[]>(
      "SELECT * FROM products WHERE barcode = $1",
      [input.barcode],
    );
    if (existing.length > 0) {
      const e = existing[0];
      await d.execute(
        `UPDATE products SET
           name = $1,
           selling_price = $2,
           stock_qty = stock_qty + $3,
           batch_no = COALESCE($4, batch_no),
           expiry_date = COALESCE($5, expiry_date),
           supplier = COALESCE($6, supplier),
           manufacturer = COALESCE($7, manufacturer),
           category = COALESCE($8, category),
           cost_price = COALESCE($9, cost_price),
           unit = COALESCE($10, unit)
         WHERE id = $11`,
        [
          input.name,
          input.sellingPrice,
          input.quantity,
          input.batchNo,
          input.expiryDate,
          input.supplier,
          input.manufacturer,
          input.category,
          input.costPrice,
          input.unit,
          e.id,
        ],
      );
      return { id: e.id, created: false };
    }
  }
  const res = await d.execute(
    `INSERT INTO products
       (name, barcode, category, manufacturer, supplier, batch_no, expiry_date,
        cost_price, selling_price, stock_qty, reorder_level, unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 10, $11)`,
    [
      input.name,
      input.barcode,
      input.category,
      input.manufacturer,
      input.supplier,
      input.batchNo,
      input.expiryDate,
      input.costPrice ?? 0,
      input.sellingPrice,
      input.quantity,
      input.unit,
    ],
  );
  return { id: Number(res.lastInsertId), created: true };
}

/** Manual / quick-add item with no barcode. */
export async function quickAddProduct(
  name: string,
  sellingPrice: number,
): Promise<number> {
  const d = await initDb();
  const res = await d.execute(
    "INSERT INTO products (name, barcode, selling_price, stock_qty, reorder_level) VALUES ($1, NULL, $2, 1, 10)",
    [name, sellingPrice],
  );
  return Number(res.lastInsertId);
}

/** Atomic sale in Rust: sale + payments + items + stock deduction, one transaction. */
export async function completeSale(
  lines: SaleLine[],
  payments: PaymentLine[],
  operator: string | null,
  patient: { name: string; phone: string } | null = null,
): Promise<SaleResult> {
  return await invoke("complete_sale", {
    payments,
    lines,
    operator,
    patientName: patient?.name?.trim() || null,
    patientPhone: patient?.phone?.trim() || null,
  });
}

export async function backupDb(): Promise<string> {
  return await invoke("backup_db");
}

export interface ReturnResult {
  receipt_no: string;
  total_refunded: number;
  return_id: number;
}

/** Refund part/all of a sale atomically in Rust; stock goes back on the shelf. */
export async function returnSale(
  saleId: number,
  lines: { product_id: number; quantity: number }[],
  reason: string | null,
  operator: string | null,
): Promise<ReturnResult> {
  return await invoke("return_sale", { saleId, lines, reason, operator });
}

/** Delete today's last sale entirely (guarded in Rust: today-only, max-id). */
export async function voidLastSale(operator: string | null): Promise<{ receipt_no: string }> {
  return await invoke("void_last_sale", { operator });
}

/** Manual stock change with a mandatory reason; logged to stock_adjustments. */
export async function adjustStock(
  productId: number,
  delta: number,
  reason: string,
  operator: string | null,
): Promise<{ product_id: number; delta: number; new_stock: number }> {
  return await invoke("adjust_stock", { productId, delta, reason, operator });
}

export interface BackupInfo {
  name: string;
  size: number;
  modified: number; // UNIX epoch seconds
}

export async function listBackups(): Promise<BackupInfo[]> {
  return await invoke("list_backups");
}

/** Swap the live DB for a backup; call restartApp() right after. */
export async function restoreBackup(name: string): Promise<string> {
  return await invoke("restore_backup", { name });
}

/** Restart the whole app (never resolves). */
export async function restartApp(): Promise<void> {
  return await invoke("restart_app");
}

export interface CashUp {
  id: number;
  day: string;
  operator: string | null;
  opening_float: number;
  counted: number;
  variance: number;
  timestamp: string;
}

/** Record a daily till reconciliation. */
export async function saveCashUp(input: {
  day: string;
  opening_float: number;
  counted: number;
  variance: number;
  operator: string | null;
}): Promise<void> {
  const d = await initDb();
  await d.execute(
    "INSERT INTO cash_ups (day, operator, opening_float, counted, variance) VALUES ($1,$2,$3,$4,$5)",
    [input.day, input.operator, input.opening_float, input.counted, input.variance],
  );
}

/** Past cash-ups for a day, newest first. */
export async function listCashUps(day: string): Promise<CashUp[]> {
  const d = await initDb();
  return await d.select<CashUp[]>(
    "SELECT id, day, operator, opening_float, counted, variance, timestamp FROM cash_ups WHERE day = $1 ORDER BY id DESC",
    [day],
  );
}

/** Write CSV rows (client-rendered) to an exports/ file; returns its path. */
export async function exportReport(name: string, rows: string[][]): Promise<string> {
  return await invoke("export_report", { name, rows });
}

export interface PurchaseOrder {
  id: number;
  po_no: string;
  supplier: string | null;
  status: "open" | "received" | "cancelled";
  created_at: string;
  item_count: number;
  /** Total quantity ordered across lines. */
  total_qty: number;
  /** Quantity received so far across lines. */
  received_qty: number;
}

export interface PoItem {
  id: number;
  po_id: number;
  product_id: number;
  product_name: string;
  qty: number;
  qty_received: number;
  unit_cost: number | null;
}

export async function loadPurchaseOrders(): Promise<PurchaseOrder[]> {
  const d = await initDb();
  return await d.select<PurchaseOrder[]>(
    `SELECT po.id, po.po_no, po.supplier, po.status, po.created_at,
            (SELECT COUNT(*) FROM po_items pi WHERE pi.po_id = po.id) AS item_count,
            (SELECT COALESCE(SUM(pi.qty),0) FROM po_items pi WHERE pi.po_id = po.id) AS total_qty,
            (SELECT COALESCE(SUM(pi.qty_received),0) FROM po_items pi WHERE pi.po_id = po.id) AS received_qty
     FROM purchase_orders po ORDER BY po.id DESC`,
  );
}

export async function loadPoItems(poId: number): Promise<PoItem[]> {
  const d = await initDb();
  return await d.select<PoItem[]>(
    "SELECT id, po_id, product_id, product_name, qty, qty_received, unit_cost FROM po_items WHERE po_id = $1 ORDER BY id",
    [poId],
  );
}

export async function createPurchaseOrder(
  supplier: string,
  items: { product_id: number; product_name: string; qty: number; unit_cost: number | null }[],
): Promise<string> {
  const d = await initDb();
  const [row] = await d.select<{ n: number; date: string }[]>(
    "SELECT COUNT(*) AS n, strftime('%Y%m%d','now','localtime') AS date FROM purchase_orders WHERE date(created_at) = date('now','localtime')",
  );
  const po_no = `REQ-${row.date}-${String(Number(row.n) + 1).padStart(3, "0")}`;
  const res = await d.execute(
    "INSERT INTO purchase_orders (po_no, supplier) VALUES ($1, $2)",
    [po_no, supplier || null],
  );
  const poId = Number(res.lastInsertId);
  for (const it of items) {
    await d.execute(
      "INSERT INTO po_items (po_id, product_id, product_name, qty, unit_cost) VALUES ($1,$2,$3,$4,$5)",
      [poId, it.product_id, it.product_name, it.qty, it.unit_cost],
    );
  }
  return po_no;
}

/** Receive a requisition atomically in Rust: stock += received, mark received
 * only when every line is complete. Partial receipts leave it open. */
export async function receivePo(
  poId: number,
  items: { po_item_id: number; qty: number }[],
): Promise<{ po_no: string; added: number; complete: boolean }> {
  return await invoke("receive_po", { poId, items });
}
