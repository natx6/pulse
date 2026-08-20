import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import type { PaymentLine, Product, SaleLine, SaleResult } from "./types";

let db: Database | null = null;

/**
 * Absolute path pointing at app_config_dir/pulse.db — the same file the
 * Rust side (db_path) reads/writes. tauri-plugin-sql resolves relative
 * sqlite:// URLs against app_data_dir, which differs from app_config_dir
 * on Linux (~/.local/share vs ~/.config), so we must use an absolute URL
 * to avoid two separate databases.
 */
export async function dbUrl(): Promise<string> {
  const dir = await appConfigDir();
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `sqlite:${dir}${sep}pulse.db`;
}

export async function initDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load(await dbUrl());
  try {
    await db.select("PRAGMA journal_mode=WAL;");
  } catch {
    // WAL is an optimization — non-fatal if unavailable
  }
  await seedSettings();
  return db;
}

/** Random 128-bit hex install identity. Generated once, lives in settings:
 * the future phone-home/server integration keys every machine off this. */
function genDeviceId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
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
    support_email: "",
    momo_number: "",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!have.has(k)) {
      await d.execute("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, v]);
    }
  }
  if (!have.has("device_id")) {
    await d.execute("INSERT INTO settings (key, value) VALUES ($1, $2)", [
      "device_id",
      genDeviceId(),
    ]);
  }
}

/** The install's permanent random ID (for support tickets and the future
 * server channel). Falls back to a placeholder if never seeded. */
export async function getDeviceId(): Promise<string> {
  const d = await initDb();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'device_id'",
  );
  return rows[0]?.value ?? "not-set";
}

export interface AppSettings {
  pharmacyName: string;
  taxRate: number;
  operator: string;
  receiptFooter: string;
  autoOperator: boolean;
  supportEmail: string;
  momoNumber: string;
  isDark: boolean;
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
    supportEmail: map.support_email ?? "",
    momoNumber: map.momo_number ?? "",
    isDark: map.is_dark === "1",
  };
}

export async function saveSetting(key: string, value: string) {
  const d = await initDb();
  await d.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/** Create a customer record from the Add Customer modal. Email is optional. */
export async function addPatient(
  name: string,
  email: string | null,
  phone: string | null,
): Promise<void> {
  const d = await initDb();
  const trimmed = name.trim();
  const em = email?.trim() || null;
  const ph = phone?.trim() || null;
  const existing: { id: number }[] = await d.select(
    "SELECT id FROM patients WHERE name = $1 COLLATE NOCASE LIMIT 1",
    [trimmed],
  );
  if (existing.length > 0) {
    // Same name → top up contact details rather than duplicating the customer.
    await d.execute(
      "UPDATE patients SET email = COALESCE($1, email), phone = COALESCE($2, phone) WHERE id = $3",
      [em, ph, existing[0].id],
    );
  } else {
    await d.execute("INSERT INTO patients (name, email, phone) VALUES ($1, $2, $3)", [
      trimmed,
      em,
      ph,
    ]);
  }
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

export async function saveReorderLevel(id: number, level: number): Promise<void> {
  const d = await initDb();
  await d.execute("UPDATE products SET reorder_level = $1 WHERE id = $2", [level, id]);
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
  discountPct: number = 0,
): Promise<SaleResult> {
  return await invoke("complete_sale", {
    payments,
    lines,
    operator,
    patientName: patient?.name?.trim() || null,
    patientPhone: patient?.phone?.trim() || null,
    discountPct: discountPct || null,
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

/** Write CSV rows (client-rendered) to the path the user chose in the
 * native Save dialog; returns the written path. */
export async function exportReport(path: string, rows: string[][]): Promise<string> {
  return await invoke("export_report", { path, rows });
}

// ---- Stock import from the old system (Excel/CSV) ----

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

export interface StockImportRow {
  name: string;
  barcode?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  strength?: string | null;
  unit?: string | null;
  rx_flag?: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  cost_price?: number | null;
  selling_price?: number | null;
  stock_qty?: number | null;
  reorder_level?: number | null;
  fda_reg_no?: string | null;
  is_controlled?: number | null;
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Parse an .xlsx/.xls/.ods/.csv export into headers + raw string rows. */
export async function parseStockFile(path: string): Promise<ParsedSheet> {
  return await invoke("parse_stock_file", { path });
}

/** Commit mapped rows in one transaction. Barcode match → name match →
 * create. A match updates prices/qty; a new row inserts a product. */
export async function commitStockImport(
  records: StockImportRow[],
): Promise<ImportSummary> {
  return await invoke("commit_stock_import", { records });
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

// ---- Requisitions (orders + supplier invoices) ----

export interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  location: string | null;
}

export async function loadSuppliers(): Promise<Supplier[]> {
  const d = await initDb();
  return await d.select<Supplier[]>("SELECT id, name, phone, location FROM suppliers ORDER BY name");
}

/** Find-or-insert a supplier by name (case-insensitive); returns its id. */
export async function addSupplier(
  name: string,
  phone?: string,
  location?: string,
): Promise<number> {
  const d = await initDb();
  await d.execute(
    "INSERT INTO suppliers (name, phone, location) VALUES ($1, $2, $3) ON CONFLICT(name) DO UPDATE SET phone = COALESCE($2, suppliers.phone), location = COALESCE($3, suppliers.location)",
    [name.trim(), phone?.trim() || null, location?.trim() || null],
  );
  const rows = await d.select<{ id: number }[]>(
    "SELECT id FROM suppliers WHERE name = $1 COLLATE NOCASE",
    [name.trim()],
  );
  return rows[0]?.id ?? 0;
}

export interface Purchase {
  id: string;
  reference_no: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  supplier_location: string | null;
  purchase_date: string;
  pay_term: string | null;
  status: "Draft" | "Ordered" | "Received";
  discount_type: "None" | "Fixed" | "Percentage";
  discount_amount: number;
  total_amount: number;
  created_at: string;
  item_count: number;
  total_qty: number;
  received_qty: number;
  paid_amount: number;
  cancelled: number;
}

export interface PurchaseItem {
  id: string;
  purchase_id: string;
  product_id: number;
  product_name: string;
  unit_type: string;
  quantity: number;
  qty_received: number;
  unit_cost_raw: number;
  discount_percent: number;
  unit_cost_net: number;
  line_total: number;
  profit_margin_percent: number | null;
  unit_selling_price: number;
  mfg_date: string | null;
  expiry_date: string;
  batch_no: string | null;
}

export async function loadPurchases(): Promise<Purchase[]> {
  const d = await initDb();
  return await d.select<Purchase[]>(
    `SELECT pu.id, pu.reference_no, pu.supplier_id, pu.supplier_name, pu.purchase_date,
            pu.pay_term, pu.status, pu.discount_type, pu.discount_amount, pu.total_amount, pu.created_at,
            s.phone AS supplier_phone, s.location AS supplier_location,
            (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count,
            (SELECT COALESCE(SUM(pi.quantity), 0) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS total_qty,
            (SELECT COALESCE(SUM(pi.qty_received), 0) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS received_qty,
            (SELECT COALESCE(SUM(pp.amount), 0) FROM purchase_payments pp WHERE pp.purchase_id = pu.id) AS paid_amount,
            pu.cancelled
     FROM purchases pu
     LEFT JOIN suppliers s ON s.id = pu.supplier_id
     WHERE pu.cancelled = 0
     ORDER BY pu.created_at DESC, pu.id DESC`,
  );
}

export async function loadPurchaseItems(purchaseId: string): Promise<PurchaseItem[]> {
  const d = await initDb();
  return await d.select<PurchaseItem[]>(
    "SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id",
    [purchaseId],
  );
}

export interface PurchaseLineInput {
  product_id: number;
  product_name: string;
  unit_type: string;
  quantity: number;
  unit_cost_raw: number;
  discount_percent: number;
  unit_selling_price: number;
  expiry_date: string;
  batch_no: string | null;
}

export interface SavePurchaseInput {
  supplier_id: number | null;
  supplier_name: string | null;
  reference_no: string | null;
  purchase_date: string;
  pay_term: string | null;
  status: string;
  discount_type: string;
  discount_amount: number;
  lines: PurchaseLineInput[];
}

/** Save a purchase atomically in Rust: header + lines + (when status is
 * 'Received') the stock commit. All pricing math is recomputed there. */
export async function savePurchase(
  input: SavePurchaseInput,
): Promise<{ id: string; total: number; items: number; received: boolean }> {
  // Tauri v2 commands expect camelCase keys for top-level args; the nested
  // line objects keep snake_case (plain serde structs).
  return await invoke("save_purchase", {
    supplierId: input.supplier_id,
    supplierName: input.supplier_name,
    referenceNo: input.reference_no,
    purchaseDate: input.purchase_date,
    payTerm: input.pay_term,
    status: input.status,
    discountType: input.discount_type,
    discountAmount: input.discount_amount,
    lines: input.lines,
  });
}

/** Receive an Ordered/Draft purchase (partially or fully) atomically in Rust.
 * invoice_cost per line = the unit cost on the supplier's invoice; the Rust
 * side compares it against the ordered cost and returns warnings on mismatch. */
export async function receivePurchase(
  purchaseId: string,
  lines: { line_id: string; qty: number; invoice_cost?: number | null }[],
): Promise<{ reference_no: string | null; added: number; complete: boolean; warnings: string[] }> {
  return await invoke("receive_purchase", { purchaseId, lines });
}

export interface UpdatePurchaseInput {
  purchase_id: string;
  supplier_id: number | null;
  supplier_name: string | null;
  reference_no: string | null;
  purchase_date: string;
  pay_term: string | null;
  status: string;
  discount_type: string;
  discount_amount: number;
  lines: PurchaseLineInput[];
}

/** Edit a Draft/Ordered purchase before any stock is received (atomic in Rust). */
export async function updatePurchase(
  input: UpdatePurchaseInput,
): Promise<{ id: string; total: number; items: number }> {
  return await invoke("update_purchase", {
    purchaseId: input.purchase_id,
    supplierId: input.supplier_id,
    supplierName: input.supplier_name,
    referenceNo: input.reference_no,
    purchaseDate: input.purchase_date,
    payTerm: input.pay_term,
    status: input.status,
    discountType: input.discount_type,
    discountAmount: input.discount_amount,
    lines: input.lines,
  });
}

/** Cancel a Draft/Ordered purchase that won't be fulfilled (atomic in Rust). */
export async function cancelPurchase(
  purchaseId: string,
  reason: string | null,
): Promise<{ id: string; reference_no: string | null }> {
  return await invoke("cancel_purchase", { purchaseId, reason });
}

/** Settle a customer's book balance — a payment against outstanding credit. */
export async function settleCredit(
  patientName: string,
  amount: number,
  method: string,
  operator: string | null,
): Promise<{ patient_name: string; paid: number; balance: number }> {
  return await invoke("settle_credit", { patientName, amount, method, operator });
}

/** Outstanding customer credit (book) balances: what each customer owes. */
export interface CustomerCredit {
  name: string;
  owed: number;
  settled: number;
}

export async function loadCustomerCredit(): Promise<CustomerCredit[]> {
  const d = await initDb();
  const rows = await d.select<{ name: string; owed: number; settled: number }[]>(
    `SELECT s.patient_name AS name,
            SUM(sp.amount) AS owed,
            COALESCE((SELECT SUM(cp.amount) FROM credit_payments cp
                      WHERE cp.patient_name = s.patient_name COLLATE NOCASE), 0) AS settled
     FROM sales s
     JOIN sale_payments sp ON sp.sale_id = s.id
     WHERE sp.method = 'Credit' AND s.patient_name IS NOT NULL AND s.patient_name != ''
     GROUP BY s.patient_name
     ORDER BY s.patient_name`,
  );
  return rows
    .map((r) => ({ name: r.name, owed: Number(r.owed), settled: Number(r.settled) }))
    .filter((r) => r.owed - r.settled > 0.005);
}

/** Controlled-drug register for the selected range: per-product summary +
 * a chronological transaction log (received / dispensed / returned / adjusted). */
export interface ControlledSummaryRow {
  name: string;
  strength: string | null;
  stock_qty: number;
  received: number;
  dispensed: number;
  returned: number;
  adjusted: number;
}

export interface ControlledTxn {
  ts: string;
  kind: "Received" | "Dispensed" | "Returned" | "Adjusted";
  product: string;
  qty: number;
  ref: string | null;
  operator: string | null;
}

export async function loadControlledRegister(
  from: string,
  to: string,
): Promise<{ summary: ControlledSummaryRow[]; txns: ControlledTxn[] }> {
  const d = await initDb();
  const summary = await d.select<
    {
      name: string;
      strength: string | null;
      stock_qty: number;
      received: number;
      dispensed: number;
      returned: number;
      adjusted: number;
    }[]
  >(
    `SELECT p.name, p.strength, p.stock_qty,
       COALESCE((SELECT SUM(pi.qty_received) FROM purchase_items pi
                 JOIN purchases pu ON pu.id = pi.purchase_id
                 WHERE pi.product_id = p.id AND pi.qty_received > 0 AND date(pu.purchase_date) BETWEEN $1 AND $2),0) AS received,
       COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                 WHERE si.product_id = p.id AND date(s.timestamp) BETWEEN $1 AND $2),0) AS dispensed,
       COALESCE((SELECT SUM(sri.quantity) FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id
                 WHERE sri.product_id = p.id AND date(sr.timestamp) BETWEEN $1 AND $2),0) AS returned,
       COALESCE((SELECT SUM(sa.delta) FROM stock_adjustments sa
                 WHERE sa.product_id = p.id AND date(sa.timestamp) BETWEEN $1 AND $2),0) AS adjusted
     FROM products p WHERE p.is_controlled = 1 AND p.active = 1 ORDER BY p.name`,
    [from, to],
  );
  const txns = await d.select<
    { ts: string; kind: ControlledTxn["kind"]; product: string; qty: number; ref: string | null; operator: string | null }[]
  >(
    `SELECT ts, kind, product, qty, ref, operator FROM (
       SELECT s.timestamp AS ts, 'Dispensed' AS kind, si.product_name AS product,
              -si.quantity AS qty, s.receipt_no AS ref, s.operator AS operator
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
       WHERE p.is_controlled = 1 AND date(s.timestamp) BETWEEN $1 AND $2
       UNION ALL
       SELECT pu.purchase_date || ' 00:00:00', 'Received', pi.product_name, pi.qty_received, pu.reference_no, NULL
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN products p ON p.id = pi.product_id
       WHERE p.is_controlled = 1 AND pi.qty_received > 0 AND date(pu.purchase_date) BETWEEN $1 AND $2
       UNION ALL
       SELECT sr.timestamp, 'Returned', sri.product_name, sri.quantity, sr.receipt_no, NULL
       FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id JOIN products p ON p.id = sri.product_id
       WHERE p.is_controlled = 1 AND date(sr.timestamp) BETWEEN $1 AND $2
       UNION ALL
       SELECT sa.timestamp, 'Adjusted', sa.product_name, sa.delta, sa.reason, sa.operator
       FROM stock_adjustments sa JOIN products p ON p.id = sa.product_id
       WHERE p.is_controlled = 1 AND date(sa.timestamp) BETWEEN $1 AND $2
     ) ORDER BY ts DESC LIMIT 300`,
    [from, to],
  );
  return {
    summary: summary.map((s) => ({
      ...s,
      stock_qty: Number(s.stock_qty),
      received: Number(s.received),
      dispensed: Number(s.dispensed),
      returned: Number(s.returned),
      adjusted: Number(s.adjusted),
    })),
    txns: txns.map((t) => ({ ...t, qty: Number(t.qty) })),
  };
}

/** Record a payment against a supplier invoice (atomic in Rust). */
export async function recordPayment(
  purchaseId: string,
  amount: number,
  method: string,
  operator: string | null,
): Promise<{ reference_no: string | null; paid: number; balance: number }> {
  return await invoke("record_payment", { purchaseId, amount, method, operator });
}

// ---- Expenses (petty cash) ----

export interface Expense {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  operator: string | null;
  timestamp: string;
}

const EXPENSE_CATEGORIES = [
  "Rent", "Utilities", "Staff", "Transport", "Maintenance",
  "Supplies", "Licenses", "Tax", "Other",
];
export { EXPENSE_CATEGORIES };

export async function addExpense(e: {
  category: string;
  description: string;
  amount: number;
  operator: string;
}): Promise<void> {
  const d = await initDb();
  await d.execute(
    "INSERT INTO expenses (category, description, amount, operator) VALUES ($1, $2, $3, $4)",
    [e.category, e.description || null, e.amount, e.operator || null],
  );
}

export async function listExpenses(from: string, to: string): Promise<Expense[]> {
  const d = await initDb();
  return d.select<Expense[]>(
    "SELECT id, category, description, amount, operator, timestamp FROM expenses WHERE date(timestamp) BETWEEN $1 AND $2 ORDER BY id DESC",
    [from, to],
  );
}

export async function expenseSummary(from: string, to: string): Promise<{ total: number; byCategory: { category: string; total: number }[] }> {
  const d = await initDb();
  const [tot] = await d.select<{ v: number }[]>(
    "SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE date(timestamp) BETWEEN $1 AND $2",
    [from, to],
  );
  const byCat = await d.select<{ category: string; total: number }[]>(
    "SELECT category, SUM(amount) AS total FROM expenses WHERE date(timestamp) BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC",
    [from, to],
  );
  return { total: Number(tot?.v ?? 0), byCategory: byCat.map((c) => ({ ...c, total: Number(c.total) })) };
}

export async function deleteExpense(id: number): Promise<void> {
  const d = await initDb();
  await d.execute("DELETE FROM expenses WHERE id = $1", [id]);
}

// ---- Supplier balances ----

export interface SupplierBalance {
  supplier_name: string;
  total_purchased: number;
  total_paid: number;
  balance: number;
  invoice_count: number;
  oldest_date: string | null;
}

export async function supplierBalances(): Promise<SupplierBalance[]> {
  const d = await initDb();
  return d.select<SupplierBalance[]>(
    `WITH pay AS (
       SELECT purchase_id, SUM(amount) AS paid FROM purchase_payments GROUP BY purchase_id
     )
     SELECT
       p.supplier_name,
       COALESCE(SUM(p.total_amount), 0) AS total_purchased,
       COALESCE(SUM(py.paid), 0) AS total_paid,
       COALESCE(SUM(p.total_amount), 0) - COALESCE(SUM(py.paid), 0) AS balance,
       COUNT(*) AS invoice_count,
       MIN(p.purchase_date) AS oldest_date
     FROM purchases p
     LEFT JOIN pay py ON py.purchase_id = p.id
     WHERE p.supplier_name IS NOT NULL AND p.supplier_name != ''
     GROUP BY p.supplier_name
     ORDER BY balance DESC`,
  );
}

// ---- Patient discount tier ----

export async function updatePatientDiscount(name: string, discountPct: number): Promise<void> {
  try {
    const d = await initDb();
    await d.execute(
      "UPDATE patients SET discount_tier = $1 WHERE name = $2",
      [discountPct, name],
    );
  } catch {
    // Column may not exist yet if migration hasn't run.
  }
}

export async function getPatientDiscount(name: string): Promise<number> {
  try {
    const d = await initDb();
    const [row] = await d.select<{ discount_tier: number | null }[]>(
      "SELECT discount_tier FROM patients WHERE name = $1",
      [name],
    );
    return Number(row?.discount_tier ?? 0);
  } catch {
    // Column may not exist yet if migration hasn't run.
    return 0;
  }
}
