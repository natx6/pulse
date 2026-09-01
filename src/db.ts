import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import type { BatchRow, PaymentLine, Product, SaleLine, SaleResult } from "./types";

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
    printer_host: "",
    printer_port: "9100",
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
  printerHost: string;
  printerPort: number;
  managerPinSet: boolean;
  isDark: boolean;
  setupComplete: boolean;
  tourSeen: boolean;
  fdaAutocomplete: boolean;
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
    printerHost: map.printer_host ?? "",
    printerPort: Number(map.printer_port ?? 9100) || 9100,
    managerPinSet: Boolean(map.manager_pin?.trim()),
    isDark: map.is_dark === "1",
    setupComplete: map.setup_complete === "1",
    tourSeen: map.tour_seen === "1",
    fdaAutocomplete: map.fda_autocomplete !== "0",
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
    // Same name → top up ONLY blank fields on that exact row; never overwrite
    // contact details already recorded for this customer.
    await d.execute(
      "UPDATE patients SET email = COALESCE(email, $1), phone = COALESCE(phone, $2) WHERE id = $3",
      [em, ph, existing[0].id],
    );
  } else {
    await d.execute("INSERT INTO patients (name, email, phone) VALUES ($1, $2, $3)", [
      trimmed,
      em,
      ph,
    ]);
    // Two rapid saves (double-tap, remount) can both miss the SELECT above
    // and each insert — collapse any duplicates to the oldest record.
    const counts = await d.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM patients WHERE name = $1 COLLATE NOCASE",
      [trimmed],
    );
    if ((counts[0]?.n ?? 0) > 1) {
      await d.execute(
        "DELETE FROM patients WHERE name = $1 COLLATE NOCASE AND id != (SELECT MIN(id) FROM patients WHERE name = $1 COLLATE NOCASE)",
        [trimmed],
      );
    }
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

/** Units per purchase pack (carton of 10 strips = 10). Min 1. */
export async function savePackSize(id: number, packSize: number): Promise<void> {
  const d = await initDb();
  await d.execute("UPDATE products SET pack_size = $1 WHERE id = $2", [
    Math.max(1, Math.floor(packSize) || 1),
    id,
  ]);
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
  packSize?: number | null;
}

/** Merge received units onto the product's FEFO ledger — now done atomically
 * inside the Rust intake command; kept only for signature history. */

/** Restock: update existing product by barcode (adds qty) or create a new
 * one — atomic in Rust (stock + FEFO batch row in one transaction). */
export async function intakeStock(input: IntakeInput): Promise<{ id: number; created: boolean }> {
  return await invoke("intake_stock", {
    input: {
      barcode: input.barcode,
      name: input.name,
      quantity: Math.floor(input.quantity),
      cost_price: input.costPrice,
      selling_price: input.sellingPrice,
      batch_no: input.batchNo,
      expiry_date: input.expiryDate,
      supplier: input.supplier,
      manufacturer: input.manufacturer,
      category: input.category,
      unit: input.unit,
      pack_size: input.packSize ?? null,
    },
  });
}

/** Manual / quick-add item with no barcode — atomic in Rust. */
export async function quickAddProduct(
  name: string,
  sellingPrice: number,
): Promise<number> {
  return await invoke("quick_add_product", { name, sellingPrice });
}

export interface NewProduct {
  name: string;
  barcode?: string | null;
  category?: string | null;
  supplier?: string | null;
  strength?: string | null;
  generic_name?: string | null;
  active_ingredient?: string | null;
  cost_price: number;
  selling_price: number;
  stock_qty: number;
  reorder_level: number;
  pack_size: number;
  batch_no?: string | null;
  expiry_date?: string | null;
}

export async function createProduct(p: NewProduct): Promise<number> {
  return await invoke("create_product", { product: p });
}

/** Per-batch breakdown of a product's stock (FEFO ledger), nearest expiry first. */
export async function loadBatches(productId: number): Promise<BatchRow[]> {
  const d = await initDb();
  const rows = await d.select<BatchRow[]>(
    `SELECT id, batch_no, expiry_date, quantity FROM product_batches
     WHERE product_id = $1 AND (quantity > 0 OR batch_no IS NOT NULL)
     ORDER BY COALESCE(NULLIF(expiry_date, ''), '9999-12-31') ASC, id ASC`,
    [productId],
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
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

// ---- ESC/POS thermal receipt printing ----

export interface ThermalReceipt {
  host: string;
  port?: number;
  pharmacy_name: string;
  receipt_no: string;
  timestamp: string;
  lines: { name: string; detail: string; amount: string }[];
  subtotal: string;
  discount?: string | null;
  tax?: string | null;
  total: string;
  payments: string[];
  change?: string | null;
  footer?: string | null;
}

/** Send the receipt to the thermal printer over raw TCP (port 9100).
 * Keys are snake_case to match the Rust struct's serde field names. */
export async function printThermalReceipt(r: ThermalReceipt): Promise<string> {
  return await invoke("print_receipt", { receipt: r });
}

export interface ReturnResult {
  receipt_no: string;
  total_refunded: number;
  return_id: number;
}

/** Refund part/all of a sale atomically in Rust; stock goes back on the shelf.
 * When a manager PIN is configured in Settings, `managerPin` must match it. */
export async function returnSale(
  saleId: number,
  lines: { product_id: number; quantity: number }[],
  reason: string | null,
  operator: string | null,
  managerPin?: string | null,
): Promise<ReturnResult> {
  return await invoke("return_sale", { saleId, lines, reason, operator, managerPin });
}

/** Delete a sale entirely — the UI sends the exact row it displayed; Rust
 * refuses anything that isn't today's newest sale (and asks for the manager
 * PIN when one is configured). */
export async function voidLastSale(
  saleId: number,
  operator: string | null,
  managerPin?: string | null,
): Promise<{ receipt_no: string }> {
  return await invoke("void_last_sale", { saleId, operator, managerPin });
}

// ---- Loss prevention ----

/** Whether a manager PIN gate is active (the PIN itself never leaves the DB
 * except through the Rust-side comparison). */
export async function isManagerPinSet(): Promise<boolean> {
  const d = await initDb();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'manager_pin'",
  );
  return Boolean(rows[0]?.value?.trim());
}

/** Set (or clear with null) the manager PIN that gates voids, refunds,
 * supplier payments and credit settlements. Changing/clearing an ACTIVE pin
 * requires `currentPin` — the Rust side stores only a salted hash. */
export async function setManagerPin(
  currentPin: string | null,
  newPin: string | null,
): Promise<void> {
  await invoke("set_manager_pin", { currentPin, newPin });
}

/** Whether `pin` verifies against the configured manager PIN. Used to unlock
 * Manager mode; with no PIN configured it is trivially true. */
export async function verifyManagerPin(pin: string | null): Promise<boolean> {
  return await invoke<boolean>("verify_manager_pin", { pin });
}

export interface StockTakeCount {
  product_id: number;
  counted: number;
}

/** Commit a completed physical count atomically in Rust: every variance
 * becomes a stock correction + batch-ledger move + 'Stock take' audit row.
 * Reductions ask for the manager PIN when one is configured. */
export async function commitStockTake(
  counts: StockTakeCount[],
  operator: string | null,
  managerPin?: string | null,
): Promise<{ changed: number; unchanged: number }> {
  return await invoke("commit_stock_take", { counts, operator, managerPin });
}

/** Copy the database to an external folder (flash drive); returns the file path. */
export async function backupDbToDir(dir: string): Promise<string> {
  return await invoke("backup_to_dir", { dir });
}

/** Manual stock change with a mandatory reason; logged to stock_adjustments.
 * Negative deltas ask for the manager PIN when one is configured. */
export async function adjustStock(
  productId: number,
  delta: number,
  reason: string,
  operator: string | null,
  managerPin?: string | null,
): Promise<{ product_id: number; delta: number; new_stock: number }> {
  return await invoke("adjust_stock", { productId, delta, reason, operator, managerPin });
}

export interface BackupInfo {
  name: string;
  size: number;
  modified: number; // UNIX epoch seconds
}

export async function listBackups(): Promise<BackupInfo[]> {
  return await invoke("list_backups");
}

/** Swap the live DB for a backup; call restartApp() right after. Gated by
 * the manager PIN on the Rust side when one is configured. */
export async function restoreBackup(name: string, pin: string | null): Promise<string> {
  return await invoke("restore_backup", { name, managerPin: pin });
}

/** Disaster-recovery restore: `dir` is a flash-drive folder holding a
 * pulse-*.db + pulse.key pair (from backupDbToDir). Validates the pair,
 * swaps both into place; call restartApp() right after. Gated by the
 * manager PIN on the Rust side when one is configured — same as the
 * backup-list restore. */
export async function restoreFromDir(dir: string, pin: string | null): Promise<string> {
  return await invoke("restore_from_dir", { dir, managerPin: pin });
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

/** The day's opening float, saved as soon as it's typed — independent of the
 * end-of-day cash-up so the dashboard sees it immediately. */
export async function getTillFloat(day: string): Promise<number | null> {
  const d = await initDb();
  const rows = await d.select<{ amount: number }[]>(
    "SELECT amount FROM till_floats WHERE day = $1",
    [day],
  );
  return rows.length > 0 ? Number(rows[0].amount) : null;
}

export async function setTillFloat(
  day: string,
  amount: number,
  operator: string | null,
): Promise<void> {
  const d = await initDb();
  await d.execute(
    `INSERT INTO till_floats (day, amount, operator) VALUES ($1, $2, $3)
     ON CONFLICT(day) DO UPDATE SET amount = excluded.amount, operator = excluded.operator`,
    [day, amount || 0, operator],
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
  pack_size?: number | null;
  fda_reg_no?: string | null;
  is_controlled?: number | null;
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** One mapped row of a customers export. */
export interface CustomerImportRow {
  name: string;
  phone?: string | null;
  discount_tier?: number | null;
  opening_balance?: number | null;
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

/** Parse a customers export — same file reader as stock. */
export async function parseCustomerFile(path: string): Promise<ParsedSheet> {
  return await invoke("parse_stock_file", { path });
}

/** Commit mapped customers in one transaction. Name match → update phone /
 * discount / opening balance (take the larger owed); no match → create. */
export async function commitCustomerImport(
  records: CustomerImportRow[],
): Promise<ImportSummary> {
  return await invoke("commit_customer_import", { records });
}

/** One mapped row of a suppliers export. */
export interface SupplierImportRow {
  name: string;
  phone?: string | null;
  location?: string | null;
  opening_balance?: number | null;
}

/** Parse a suppliers export — same file reader as stock. */
export async function parseSupplierFile(path: string): Promise<ParsedSheet> {
  return await invoke("parse_stock_file", { path });
}

/** Commit mapped suppliers in one transaction. Name match → update phone /
 * location / opening balance (take the larger owed); no match → create. */
export async function commitSupplierImport(
  records: SupplierImportRow[],
): Promise<ImportSummary> {
  return await invoke("commit_supplier_import", { records });
}

export interface DemoPurgeSummary {
  sales: number;
  purchases: number;
  suppliers: number;
  products: number;
  patients: number;
}

/** Wipe all sample/demo rows (manager-PIN protected) so a database can be
 * handed to a real client clean. */
export async function purgeDemoData(managerPin: string | null): Promise<DemoPurgeSummary> {
  return await invoke("purge_demo_data", { managerPin });
}



/** True when any demo/sample row is present. Used to hide the "Clear sample
 * data" control in release builds, where the demo/seed migrations are skipped
 * and the database ships empty — the button would otherwise be a dead no-op. */
export async function hasDemoData(): Promise<boolean> {
  const d = await initDb();
  const rows = await d.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM sales WHERE receipt_no LIKE 'DMO-%'
       UNION ALL SELECT 1 FROM suppliers WHERE name LIKE 'Demo%'
       UNION ALL SELECT 1 FROM patients WHERE name = 'Ama Mensah' OR phone = '0241234567'
       UNION ALL SELECT 1 FROM products WHERE barcode LIKE '6220000000%' OR name LIKE 'Demo —%'
     )`,
    [],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export interface FdaDrug {
  id: string;
  product_id: string | null;
  product_name: string;
  generic_name: string | null;
  strength: string | null;
  active_ingredient: string | null;
  dosage_form: string | null;
  product_category: string | null;
  product_sub_category: string | null;
  registration_number: string | null;
  manufacturer: string | null;
  client_name: string | null;
  registration_date: string | null;
  expiry_date: string | null;
  status: string | null;
}

export async function searchFdaDrugs(query: string, limit = 20): Promise<FdaDrug[]> {
  return await invoke("search_fda_drugs", { query, limit });
}

export async function importFdaCatalog(drugs: FdaDrug[]): Promise<number> {
  return await invoke("import_fda_catalog", { drugs });
}

export async function refreshFdaCatalog(): Promise<number> {
  return await invoke("refresh_fda_catalog");
}

export interface AppUser {
  id: number;
  username: string;
  display_name: string;
  role: "manager" | "worker";
  is_active: number;
  must_change_password: number;
  created_at: string;
}

export async function createUser(
  username: string,
  displayName: string,
  password: string,
  role: "manager" | "worker",
): Promise<AppUser> {
  return await invoke("create_user", { username, displayName, password, role });
}

export async function loginUser(username: string, password: string): Promise<AppUser> {
  return await invoke("login_user", { username, password });
}

export async function listUsers(): Promise<AppUser[]> {
  return await invoke("list_users");
}

export async function updateUser(
  id: number,
  opts: { display_name?: string; role?: "manager" | "worker"; is_active?: boolean },
): Promise<AppUser> {
  return await invoke("update_user", {
    id,
    displayName: opts.display_name ?? null,
    role: opts.role ?? null,
    isActive: opts.is_active ?? null,
  });
}

export async function resetUserPassword(id: number, newPassword: string): Promise<void> {
  return await invoke("reset_user_password", { id, newPassword });
}

export async function changeOwnPassword(
  username: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return await invoke("change_own_password", { username, oldPassword, newPassword });
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

/** Find-or-insert a supplier by name (case-insensitive); returns its id.
 * The upsert is authoritative — the id comes back from the same statement
 * via RETURNING, so a concurrent insert or a NOCASE collision can never
 * yield a mismatched (or sentinel 0) id. */
export async function addSupplier(
  name: string,
  phone?: string,
  location?: string,
): Promise<number> {
  const d = await initDb();
  const rows = await d.select<{ id: number }[]>(
    "INSERT INTO suppliers (name, phone, location) VALUES ($1, $2, $3) " +
      "ON CONFLICT(name) DO UPDATE SET phone = COALESCE($2, suppliers.phone), location = COALESCE($3, suppliers.location) " +
      "RETURNING id",
    [name.trim(), phone?.trim() || null, location?.trim() || null],
  );
  if (!rows[0]?.id) {
    throw new Error(`Couldn't resolve supplier "${name.trim()}"`);
  }
  return rows[0].id;
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

/** Settle a customer's book balance — a payment against outstanding credit.
 * Money out the door: `managerPin` is required when one is configured. */
export async function settleCredit(
  patientName: string,
  amount: number,
  method: string,
  operator: string | null,
  managerPin?: string | null,
): Promise<{ patient_name: string; paid: number; balance: number }> {
  return await invoke("settle_credit", { patientName, amount, method, operator, managerPin });
}

/** Outstanding customer credit (book) balances: what each customer owes. */
export interface CustomerCredit {
  name: string;
  owed: number;
  settled: number;
}

export async function loadCustomerCredit(): Promise<CustomerCredit[]> {
  const d = await initDb();
  // Group on a NOCASE-normalized key so "john" and "John" are one debtor;
  // settlements already matched by NOCASE, so the grouping must too.
  // `owed` includes both credit sale-payments AND a patient's opening_balance
  // (carry-over debt imported from an old system); a customer who owes purely
  // from an opening balance and has no credit sales still shows up here.
  const rows = await d.select<{ name: string; owed: number; settled: number }[]>(
    `WITH credit_sales AS (
        SELECT s.patient_name AS name, SUM(sp.amount) AS owed
        FROM sales s JOIN sale_payments sp ON sp.sale_id = s.id AND sp.method = 'Credit'
        WHERE s.patient_name IS NOT NULL AND s.patient_name != ''
        GROUP BY s.patient_name COLLATE NOCASE
     ),
     settled AS (
        SELECT patient_name AS name, SUM(amount) AS settled
        FROM credit_payments GROUP BY patient_name COLLATE NOCASE
     ),
     openings AS (
        SELECT name, MAX(opening_balance) AS opening
        FROM patients WHERE opening_balance > 0.005
        GROUP BY name COLLATE NOCASE
     ),
     names AS (
        SELECT name FROM credit_sales
        UNION SELECT name FROM settled
        UNION SELECT name FROM openings
     )
     SELECT n.name AS name,
            COALESCE(cs.owed, 0) + COALESCE(o.opening, 0) AS owed,
            COALESCE(se.settled, 0) AS settled
     FROM names n
     LEFT JOIN credit_sales cs ON cs.name = n.name COLLATE NOCASE
     LEFT JOIN settled se ON se.name = n.name COLLATE NOCASE
     LEFT JOIN openings o ON o.name = n.name COLLATE NOCASE
     WHERE (COALESCE(cs.owed, 0) + COALESCE(o.opening, 0) - COALESCE(se.settled, 0)) > 0.005
     ORDER BY n.name`,
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
     ) ORDER BY ts DESC LIMIT 2000`,
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

/** Record a payment against a supplier invoice (atomic in Rust). Money out
 * the door: `managerPin` is required when one is configured. */
export async function recordPayment(
  purchaseId: string,
  amount: number,
  method: string,
  operator: string | null,
  managerPin?: string | null,
): Promise<{ reference_no: string | null; paid: number; balance: number }> {
  return await invoke("record_payment", { purchaseId, amount, method, operator, managerPin });
}

// ---- Expenses (petty cash) ----

export interface Expense {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  operator: string | null;
  payment_method: string;
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
  paymentMethod: string;
}): Promise<void> {
  const d = await initDb();
  await d.execute(
    "INSERT INTO expenses (category, description, amount, operator, payment_method) VALUES ($1, $2, $3, $4, $5)",
    [e.category, e.description || null, e.amount, e.operator || null, e.paymentMethod || "Cash"],
  );
}

export async function listExpenses(from: string, to: string): Promise<Expense[]> {
  const d = await initDb();
  return d.select<Expense[]>(
    "SELECT id, category, description, amount, operator, payment_method, timestamp FROM expenses WHERE date(timestamp) BETWEEN $1 AND $2 ORDER BY id DESC",
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
     ),
     purch AS (
       SELECT p.supplier_name,
              COALESCE(SUM(p.total_amount), 0) AS total_purchased,
              COALESCE(SUM(py.paid), 0) AS total_paid,
              COUNT(*) AS invoice_count,
              MIN(p.purchase_date) AS oldest_date
       FROM purchases p
       LEFT JOIN pay py ON py.purchase_id = p.id
       WHERE p.supplier_name IS NOT NULL AND p.supplier_name != '' AND p.cancelled = 0
       GROUP BY p.supplier_name
     ),
     open AS (
       SELECT name AS supplier_name, MAX(opening_balance) AS opening
       FROM suppliers WHERE opening_balance > 0.005 GROUP BY name COLLATE NOCASE
     ),
     names AS (
       SELECT supplier_name FROM purch
       UNION SELECT supplier_name FROM open
     )
     SELECT n.supplier_name AS supplier_name,
            COALESCE(pr.total_purchased, 0) AS total_purchased,
            COALESCE(pr.total_paid, 0) AS total_paid,
            COALESCE(pr.total_purchased, 0) - COALESCE(pr.total_paid, 0) + COALESCE(o.opening, 0) AS balance,
            COALESCE(pr.invoice_count, 0) AS invoice_count,
            COALESCE(pr.oldest_date, NULL) AS oldest_date
     FROM names n
     LEFT JOIN purch pr ON pr.supplier_name = n.supplier_name COLLATE NOCASE
     LEFT JOIN open o ON o.supplier_name = n.supplier_name COLLATE NOCASE
     WHERE (COALESCE(pr.total_purchased, 0) - COALESCE(pr.total_paid, 0) + COALESCE(o.opening, 0)) > 0.005
     ORDER BY balance DESC`,
  );
}

// ---- Patient discount tier ----

export async function updatePatientDiscount(name: string, discountPct: number): Promise<void> {
  const d = await initDb();
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    throw new Error("Discount must be between 0 and 100");
  }
  const res = await d.execute(
    "UPDATE patients SET discount_tier = $1 WHERE name = $2",
    [discountPct, name],
  );
  if (res.rowsAffected === 0) {
    throw new Error(`No customer named "${name}" to update.`);
  }
}

export async function getPatientDiscount(name: string): Promise<number> {
  const d = await initDb();
  const [row] = await d.select<{ discount_tier: number | null }[]>(
    "SELECT discount_tier FROM patients WHERE name = $1",
    [name],
  );
  return Number(row?.discount_tier ?? 0);
}
