use rusqlite::{OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};
#[derive(Deserialize)]
pub struct SaleLine {
    product_id: i64,
    name: String,
    quantity: i64,
    unit_price: f64,
    #[serde(default)]
    unit: Option<String>,
}

#[derive(Deserialize)]
pub struct Payment {
    method: String,
    amount: f64,
    #[serde(default)]
    reference: Option<String>,
}

#[derive(Serialize)]
pub struct SaleResult {
    receipt_no: String,
    sale_id: i64,
    total: f64,
    change: f64,
}

/// One row of a stock import, produced by the frontend column mapping.
/// All fields optional except `name`; None means "leave the existing value"
/// on update, or the column default on insert.
#[derive(Deserialize)]
pub struct StockImportRow {
    name: String,
    #[serde(default)]
    barcode: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    manufacturer: Option<String>,
    #[serde(default)]
    supplier: Option<String>,
    #[serde(default)]
    strength: Option<String>,
    #[serde(default)]
    unit: Option<String>,
    #[serde(default)]
    rx_flag: Option<i64>,
    #[serde(default)]
    batch_no: Option<String>,
    #[serde(default)]
    expiry_date: Option<String>,
    #[serde(default)]
    cost_price: Option<f64>,
    #[serde(default)]
    selling_price: Option<f64>,
    #[serde(default)]
    stock_qty: Option<f64>,
    #[serde(default)]
    reorder_level: Option<i64>,
    #[serde(default)]
    fda_reg_no: Option<String>,
    #[serde(default)]
    is_controlled: Option<i64>,
}

#[derive(Serialize)]
pub struct ParsedSheet {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
pub struct ImportSummary {
    created: usize,
    updated: usize,
    skipped: usize,
    errors: Vec<String>,
}

/// MUST match tauri-plugin-sql's resolution of "sqlite:pulse.db": the plugin
/// resolves relative sqlite paths against the app CONFIG dir on Linux
/// (~/.config/<identifier>/pulse.db), NOT the app data dir. Verified via lsof
/// on a running instance. Getting this wrong silently creates a second,
/// empty database and every sale fails with "no such table".
fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pulse.db"))
}

/// One atomic transaction: insert sale + payments + items, deduct stock.
/// All or nothing. `payments` supports split settlement (e.g. GH₵ 50 Cash +
/// GH₵ 70 MoMo); the first payment is the sale's primary method.
#[tauri::command]
fn complete_sale(
    app: AppHandle,
    payments: Vec<Payment>,
    lines: Vec<SaleLine>,
    operator: Option<String>,
    patient_name: Option<String>,
    patient_phone: Option<String>,
) -> Result<SaleResult, String> {
    if lines.is_empty() {
        return Err("Cart is empty".into());
    }
    if payments.is_empty() {
        return Err("No payment method".into());
    }
    let mut paid = 0.0;
    for p in &payments {
        if !matches!(p.method.as_str(), "Cash" | "Card" | "MoMo" | "Credit") {
            return Err("Unknown payment method".into());
        }
        if p.amount <= 0.0 {
            return Err(format!("Payment amount for {} must be positive", p.method));
        }
        paid += p.amount;
    }
    // Book sales must be tied to a customer — otherwise "what do they owe"
    // has nobody to attach to.
    if payments.iter().any(|p| p.method == "Credit") {
        let name = patient_name.as_deref().map(str::trim).unwrap_or("");
        if name.is_empty() {
            return Err(
                "Credit sales need a customer name — attach one at the counter".into(),
            );
        }
    }

    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // 1. Stock check (fail before writing anything)
    for l in &lines {
        let st: i64 = tx
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [l.product_id], |r| r.get(0))
            .map_err(|_| format!("Unknown product: {}", l.name))?;
        if st < l.quantity {
            return Err(format!(
                "Not enough stock for {} (have {}, need {})",
                l.name, st, l.quantity
            ));
        }
    }

    // 2. Receipt number: per-day sequence, computed inside the transaction
    let n: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM sales WHERE date(timestamp) = date('now', 'localtime')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let date: String = tx
        .query_row("SELECT strftime('%Y%m%d', 'now', 'localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let receipt_no = format!("RCPT-{}-{:03}", date, n + 1);

    let total: f64 = lines.iter().map(|l| l.unit_price * l.quantity as f64).sum();
    if paid < total - 0.005 {
        return Err(format!(
            "Payments (GH₵ {:.2}) don't cover the total (GH₵ {:.2})",
            paid, total
        ));
    }
    let change = (paid - total).max(0.0);
    let primary = payments[0].method.clone();

    // 3. Sale
    tx.execute(
        "INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            receipt_no,
            total,
            primary,
            operator,
            paid,
            change,
            patient_name,
            patient_phone
        ],
    )
    .map_err(|e| e.to_string())?;
    let sale_id = tx.last_insert_rowid();

    // 3a. Patient lookup index: populate `patients` (name-keyed) so search and
    // history work. The sale itself keeps the name/phone snapshot.
    if let Some(name) = patient_name.as_deref().map(str::trim) {
        if !name.is_empty() {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM patients WHERE name = ?1 LIMIT 1",
                    [name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match existing {
                Some(pid) => {
                    if patient_phone.as_deref().is_some_and(|p| !p.trim().is_empty()) {
                        tx.execute(
                            "UPDATE patients SET phone = COALESCE(?1, phone) WHERE id = ?2",
                            rusqlite::params![patient_phone, pid],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
                None => {
                    tx.execute(
                        "INSERT INTO patients (name, phone) VALUES (?1, ?2)",
                        rusqlite::params![name, patient_phone],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    // 3b. Payment lines (one per method, optional transaction reference)
    for p in &payments {
        tx.execute(
            "INSERT INTO sale_payments (sale_id, method, amount, reference) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![sale_id, p.method, p.amount, p.reference],
        )
        .map_err(|e| e.to_string())?;
    }

    // 4. Items + stock deduction
    for l in &lines {
        tx.execute(
            "INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![sale_id, l.product_id, l.name, l.quantity, l.unit_price, l.unit],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty - ?1 WHERE id = ?2",
            rusqlite::params![l.quantity, l.product_id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    // Auto-backup every 10th sale (power-cut insurance). Best-effort: a
    // backup failure must never fail the sale that already committed.
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sales", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if n % 10 == 0 {
        if let Err(e) = write_backup(&app) {
            eprintln!("auto-backup failed: {e}");
        }
    }

    Ok(SaleResult {
        receipt_no,
        sale_id,
        total,
        change,
    })
}

/// WAL-safe backup: copy the live database with the SQLite online backup API
/// (a plain file copy would miss uncheckpointed WAL pages and could capture a
/// torn state). Used by the manual button, every 10th sale, and app exit.
/// After writing, backups/ is pruned to the newest 20 files (best-effort —
/// a prune failure must never fail a sale).
fn write_backup(app: &AppHandle) -> Result<String, String> {
    let src_path = db_path(app)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let bdir = dir.join("backups");
    fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dst = bdir.join(format!("pulse-{}.db", epoch));
    backup_to_path(&src_path, &dst)?;
    prune_backups(&bdir);
    Ok(dst.to_string_lossy().into_owned())
}

/// WAL-safe copy of one SQLite file to a destination path (online backup API).
fn backup_to_path(src_path: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let src = rusqlite::Connection::open_with_flags(
        src_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    src.backup(rusqlite::DatabaseName::Main, dst, None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep only the newest 20 backup files. Names are timestamped, so lexical
/// sort == chronological. Best-effort: failures are swallowed.
fn prune_backups(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
        .collect();
    files.sort();
    while files.len() > 20 {
        let _ = fs::remove_file(&files.remove(0));
    }
}

/// Copy the SQLite file to backups/ (beside the database) with a timestamped name.
#[tauri::command]
fn backup_db(app: AppHandle) -> Result<String, String> {
    write_backup(&app)
}

/// Write report rows (already rendered client-side) to the CSV file the user
/// picked in the native Save dialog. Returns the written path.
#[tauri::command]
fn export_report(path: String, rows: Vec<Vec<String>>) -> Result<String, String> {
    let mut out = String::new();
    for r in &rows {
        let line: Vec<String> = r
            .iter()
            .map(|c| {
                if c.contains(',') || c.contains('"') || c.contains('\n') {
                    format!("\"{}\"", c.replace('"', "\"\""))
                } else {
                    c.clone()
                }
            })
            .collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("Can't write {}: {}", path, e))?;
    Ok(path)
}

#[derive(Deserialize)]
pub struct ReceiveLine {
    po_item_id: i64,
    qty: i64,
}

/// One line of a purchase (supplier invoice) being saved or received.
#[derive(Deserialize)]
pub struct PurchaseLine {
    product_id: i64,
    product_name: String,
    unit_type: String,
    quantity: f64,
    unit_cost_raw: f64,
    discount_percent: f64,
    unit_selling_price: f64,
    #[serde(default)]
    mfg_date: Option<String>,
    expiry_date: String,
}

/// A receive request against an existing (Ordered/Draft) purchase line.
/// invoice_cost is the unit cost on the supplier's invoice, used for the
/// three-way match (order vs delivery vs invoice); None = skip the check.
#[derive(Deserialize)]
pub struct PurchaseReceiveLine {
    line_id: String,
    qty: f64,
    #[serde(default)]
    invoice_cost: Option<f64>,
}

#[derive(Deserialize)]
pub struct ReturnLine {
    product_id: i64,
    quantity: i64,
}

#[derive(Serialize)]
pub struct ReturnResult {
    receipt_no: String,
    total_refunded: f64,
    return_id: i64,
}

#[derive(Serialize)]
pub struct BackupInfo {
    name: String,
    size: u64,
    /// UNIX epoch seconds — formatted client-side.
    modified: u64,
}

/// Receive a requisition (partially or fully): add the received quantities to
/// stock, update costs, and mark the PO received only when every line is
/// complete. One transaction, all or nothing. The UI derives a "partial"
/// display state from qty_received vs qty; status stays 'open' until done.
#[tauri::command]
fn receive_po(
    app: AppHandle,
    po_id: i64,
    items: Vec<ReceiveLine>,
) -> Result<serde_json::Value, String> {
    if items.is_empty() {
        return Err("Nothing to receive".into());
    }
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let (po_no, status): (String, String) = tx
        .query_row(
            "SELECT po_no, status FROM purchase_orders WHERE id = ?1",
            [po_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Requisition not found".to_string())?;
    if status != "open" {
        return Err(format!("{} is already {}", po_no, status));
    }

    let mut added = 0i64;
    for rl in &items {
        if rl.qty <= 0 {
            return Err("Received quantity must be positive".into());
        }
        let (product_id, qty, qty_received, unit_cost): (i64, i64, i64, Option<f64>) = tx
            .query_row(
                "SELECT product_id, qty, qty_received, unit_cost FROM po_items WHERE id = ?1 AND po_id = ?2",
                rusqlite::params![rl.po_item_id, po_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| "Requisition item not found".to_string())?;
        let rem = qty - qty_received;
        if rl.qty > rem {
            return Err(format!(
                "Receiving {} exceeds the {} still outstanding on this line",
                rl.qty, rem
            ));
        }
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty + ?1, cost_price = COALESCE(?2, cost_price) WHERE id = ?3",
            rusqlite::params![rl.qty, unit_cost, product_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE po_items SET qty_received = qty_received + ?1 WHERE id = ?2",
            rusqlite::params![rl.qty, rl.po_item_id],
        )
        .map_err(|e| e.to_string())?;
        added += rl.qty;
    }

    // Received only when every line is complete; otherwise stays open (the UI
    // shows the partial state from qty_received vs qty).
    let outstanding: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM po_items WHERE po_id = ?1 AND qty_received < qty",
            [po_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let complete = outstanding == 0;
    if complete {
        tx.execute(
            "UPDATE purchase_orders SET status = 'received' WHERE id = ?1",
            [po_id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "po_no": po_no, "added": added, "complete": complete }))
}

/// Resolve the supplier for a purchase: by id (authoritative, from the
/// suppliers table) or by name (find-or-insert, case-insensitive). Returns
/// (supplier_id, supplier_name).
fn resolve_supplier(
    tx: &rusqlite::Transaction,
    supplier_id: Option<i64>,
    supplier_name: Option<&str>,
) -> Result<(Option<i64>, Option<String>), String> {
    if let Some(sid) = supplier_id {
        let name: Option<String> = tx
            .query_row("SELECT name FROM suppliers WHERE id = ?1", [sid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        match name {
            Some(n) => Ok((Some(sid), Some(n))),
            None => Err("Supplier not found".into()),
        }
    } else if let Some(name) = supplier_name.map(str::trim).filter(|s| !s.is_empty()) {
        tx.execute("INSERT OR IGNORE INTO suppliers (name) VALUES (?1)", [name])
            .map_err(|e| e.to_string())?;
        let sid: i64 = tx
            .query_row(
                "SELECT id FROM suppliers WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok((Some(sid), Some(name.to_string())))
    } else {
        Ok((None, None))
    }
}

/// Stock side of a purchase line being received: add the quantity, stamp the
/// new cost/selling prices, packaging unit, expiry and supplier onto the
/// product. Called inside the purchase transaction only.
fn commit_purchase_stock(
    tx: &rusqlite::Transaction,
    product_id: i64,
    name: &str,
    qty: f64,
    unit_type: &str,
    net: f64,
    selling: f64,
    expiry: &str,
    supplier: Option<&str>,
) -> Result<(), String> {
    let add = qty.round() as i64;
    let n = tx
        .execute(
            "UPDATE products SET
               stock_qty = stock_qty + ?1,
               cost_price = ?2,
               selling_price = ?3,
               unit = ?4,
               expiry_date = COALESCE(NULLIF(?5, ''), expiry_date),
               supplier = COALESCE(?6, supplier)
             WHERE id = ?7",
            rusqlite::params![add, net, selling, unit_type, expiry, supplier, product_id],
        )
        .map_err(|e| format!("Stock update failed for {}: {}", name, e))?;
    if n == 0 {
        return Err(format!("Unknown product: {}", name));
    }
    Ok(())
}

/// Server-side purchase pricing — the ONLY source of truth for what gets
/// stored (client totals are never trusted). Returns (subtotal, net_total,
/// per-line (net, total, margin)).
fn compute_purchase_pricing(
    lines: &[PurchaseLine],
    discount_type: &str,
    discount_amount: f64,
) -> Result<(f64, f64, Vec<(f64, f64, Option<f64>)>), String> {
    let mut subtotal = 0.0;
    let mut computed: Vec<(f64, f64, Option<f64>)> = Vec::with_capacity(lines.len());
    for l in lines {
        if l.quantity <= 0.0 {
            return Err(format!("Quantity for {} must be positive", l.product_name));
        }
        if l.unit_cost_raw < 0.0 {
            return Err(format!("Unit cost for {} can't be negative", l.product_name));
        }
        if !(0.0..=100.0).contains(&l.discount_percent) {
            return Err(format!("Discount % for {} must be 0–100", l.product_name));
        }
        if l.unit_selling_price < 0.0 {
            return Err(format!("Selling price for {} can't be negative", l.product_name));
        }
        let net = l.unit_cost_raw * (1.0 - l.discount_percent / 100.0);
        let total = l.quantity * net;
        let margin = if l.unit_selling_price > 0.0 {
            Some(((l.unit_selling_price - net) / l.unit_selling_price * 100.0 * 100.0).round() / 100.0)
        } else {
            None
        };
        subtotal += total;
        computed.push(((net * 100.0).round() / 100.0, (total * 100.0).round() / 100.0, margin));
    }
    let net_total = match discount_type {
        "Fixed" => (subtotal - discount_amount).max(0.0),
        "Percentage" => subtotal * (1.0 - discount_amount / 100.0),
        _ => subtotal,
    };
    Ok((subtotal, (net_total * 100.0).round() / 100.0, computed))
}

/// Save a purchase (supplier invoice) atomically: header + batch lines in one
/// transaction. All pricing math is recomputed here — the client totals are
/// never trusted. When status = 'Received' the stock lands immediately
/// (products.stock_qty += qty, cost_price/selling_price/unit/expiry updated);
/// Draft/Ordered just records the order for later receiving.
#[tauri::command]
fn save_purchase(
    app: AppHandle,
    supplier_id: Option<i64>,
    supplier_name: Option<String>,
    reference_no: Option<String>,
    purchase_date: String,
    pay_term: Option<String>,
    status: String,
    discount_type: String,
    discount_amount: f64,
    lines: Vec<PurchaseLine>,
) -> Result<serde_json::Value, String> {
    if lines.is_empty() {
        return Err("Add at least one product".into());
    }
    if !matches!(status.as_str(), "Draft" | "Ordered" | "Received") {
        return Err("Invalid status".into());
    }
    if !matches!(discount_type.as_str(), "None" | "Fixed" | "Percentage") {
        return Err("Invalid discount type".into());
    }
    if discount_amount < 0.0 {
        return Err("Discount can't be negative".into());
    }
    if discount_type == "Percentage" && discount_amount > 100.0 {
        return Err("Percentage discount can't exceed 100%".into());
    }
    let purchase_date = purchase_date.trim().to_string();
    if purchase_date.is_empty() {
        return Err("Purchase date is required".into());
    }
    let pay_term = match pay_term.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => "Cash".to_string(),
    };

    // Server-side math (the source of truth for what gets stored).
    let (_subtotal, net_total, computed) =
        compute_purchase_pricing(&lines, &discount_type, discount_amount)?;

    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // Display number: per-day sequence, computed inside the transaction.
    let n: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM purchases WHERE date(purchase_date) = date(?1)",
            [&purchase_date],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let seq_date = purchase_date.replace('-', "");
    let id = format!("PUR-{}-{:03}", seq_date, n + 1);

    let (sup_id, sup_name) = resolve_supplier(&tx, supplier_id, supplier_name.as_deref())?;
    // Blank reference → use the display number so the field is never empty.
    let reference_no = match reference_no.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => Some(r.to_string()),
        None => Some(id.clone()),
    };

    tx.execute(
        "INSERT INTO purchases (id, reference_no, supplier_id, supplier_name, purchase_date,
                                pay_term, status, discount_type, discount_amount, total_amount, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now', 'localtime'))",
        rusqlite::params![
            id,
            reference_no,
            sup_id,
            sup_name,
            purchase_date,
            pay_term,
            status,
            discount_type,
            discount_amount,
            net_total
        ],
    )
    .map_err(|e| e.to_string())?;

    for (i, l) in lines.iter().enumerate() {
        let (net, total, margin) = computed[i];
        let item_id = format!("{}-{}", id, i + 1);
        tx.execute(
            "INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_type,
                                         quantity, qty_received, unit_cost_raw, discount_percent,
                                         unit_cost_net, line_total, profit_margin_percent,
                                         unit_selling_price, mfg_date, expiry_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            rusqlite::params![
                item_id,
                id,
                l.product_id,
                l.product_name,
                l.unit_type,
                l.quantity,
                if status == "Received" { l.quantity } else { 0.0 },
                l.unit_cost_raw,
                l.discount_percent,
                net,
                total,
                margin,
                l.unit_selling_price,
                l.mfg_date,
                l.expiry_date
            ],
        )
        .map_err(|e| e.to_string())?;
        if status == "Received" {
            commit_purchase_stock(
                &tx,
                l.product_id,
                &l.product_name,
                l.quantity,
                &l.unit_type,
                net,
                l.unit_selling_price,
                &l.expiry_date,
                sup_name.as_deref(),
            )?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "total": net_total,
        "items": lines.len(),
        "received": status == "Received",
    }))
}

/// Receive an Ordered/Draft purchase (partially or fully): add the received
/// quantities to stock with the saved costs/prices, and mark the purchase
/// 'Received' only when every line is complete. One transaction.
#[tauri::command]
fn receive_purchase(
    app: AppHandle,
    purchase_id: String,
    lines: Vec<PurchaseReceiveLine>,
) -> Result<serde_json::Value, String> {
    if lines.is_empty() {
        return Err("Nothing to receive".into());
    }
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let (ref_no, status, cancelled): (Option<String>, String, i64) = tx
        .query_row(
            "SELECT reference_no, status, cancelled FROM purchases WHERE id = ?1",
            [&purchase_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "Purchase not found".to_string())?;
    if cancelled != 0 {
        return Err("This purchase was cancelled".into());
    }
    if status == "Received" {
        return Err(format!(
            "{} is already received",
            ref_no.as_deref().unwrap_or(&purchase_id)
        ));
    }

    let mut added = 0.0;
    let mut warnings: Vec<String> = Vec::new();
    for rl in &lines {
        if rl.qty <= 0.0 {
            return Err("Received quantity must be positive".into());
        }
        if let Some(inv) = rl.invoice_cost {
            if inv < 0.0 {
                return Err("Invoice cost can't be negative".into());
            }
        }
        let (product_id, product_name, qty, qty_received, unit_type, net, selling, expiry): (
            i64,
            String,
            f64,
            f64,
            String,
            f64,
            f64,
            String,
        ) = tx
            .query_row(
                "SELECT product_id, product_name, quantity, qty_received, unit_type,
                        unit_cost_net, unit_selling_price, expiry_date
                 FROM purchase_items WHERE id = ?1 AND purchase_id = ?2",
                rusqlite::params![rl.line_id, purchase_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .map_err(|_| "Purchase line not found".to_string())?;
        let rem = qty - qty_received;
        if rl.qty > rem {
            return Err(format!(
                "Receiving {} exceeds the {} still outstanding on '{}'",
                rl.qty, rem, product_name
            ));
        }
        // Three-way match: does the supplier's invoice unit cost agree with
        // what we ordered? Report differences (never block, never rewrite).
        if let Some(inv) = rl.invoice_cost {
            if (inv - net).abs() > 0.005 {
                warnings.push(format!(
                    "{}: invoice {:.2} vs ordered {:.2}",
                    product_name, inv, net
                ));
            }
        }
        commit_purchase_stock(&tx, product_id, &product_name, rl.qty, &unit_type, net, selling, &expiry, None)?;
        tx.execute(
            "UPDATE purchase_items SET qty_received = qty_received + ?1 WHERE id = ?2",
            rusqlite::params![rl.qty, rl.line_id],
        )
        .map_err(|e| e.to_string())?;
        added += rl.qty;
    }

    let outstanding: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM purchase_items WHERE purchase_id = ?1 AND qty_received < quantity",
            [&purchase_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let complete = outstanding == 0;
    if complete {
        tx.execute(
            "UPDATE purchases SET status = 'Received' WHERE id = ?1",
            [&purchase_id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "reference_no": ref_no,
        "added": added,
        "complete": complete,
        "warnings": warnings,
    }))
}

/// Edit a Draft/Ordered purchase that hasn't had any stock received yet:
/// header + lines replaced atomically, totals recomputed server-side. A
/// purchase with any received quantity is locked (receive or cancel instead).
#[tauri::command]
fn update_purchase(
    app: AppHandle,
    purchase_id: String,
    supplier_id: Option<i64>,
    supplier_name: Option<String>,
    reference_no: Option<String>,
    purchase_date: String,
    pay_term: Option<String>,
    status: String,
    discount_type: String,
    discount_amount: f64,
    lines: Vec<PurchaseLine>,
) -> Result<serde_json::Value, String> {
    if lines.is_empty() {
        return Err("Add at least one product".into());
    }
    if !matches!(status.as_str(), "Draft" | "Ordered") {
        return Err("Only Draft or Ordered can be edited — receive it to add stock".into());
    }
    if !matches!(discount_type.as_str(), "None" | "Fixed" | "Percentage") {
        return Err("Invalid discount type".into());
    }
    if discount_amount < 0.0 {
        return Err("Discount can't be negative".into());
    }
    if discount_type == "Percentage" && discount_amount > 100.0 {
        return Err("Percentage discount can't exceed 100%".into());
    }
    let purchase_date = purchase_date.trim().to_string();
    if purchase_date.is_empty() {
        return Err("Purchase date is required".into());
    }
    let pay_term = match pay_term.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => "Cash".to_string(),
    };

    let (_subtotal, net_total, computed) =
        compute_purchase_pricing(&lines, &discount_type, discount_amount)?;

    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let (cur_status, cancelled): (String, i64) = tx
        .query_row(
            "SELECT status, cancelled FROM purchases WHERE id = ?1",
            [&purchase_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Purchase not found".to_string())?;
    if cancelled != 0 {
        return Err("A cancelled purchase can't be edited".into());
    }
    if cur_status == "Received" {
        return Err("A received purchase can't be edited".into());
    }
    let received: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM purchase_items WHERE purchase_id = ?1 AND qty_received > 0",
            [&purchase_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if received > 0 {
        return Err(
            "Can't edit — some lines were already received. Receive the rest or cancel.".into(),
        );
    }

    let (sup_id, sup_name) = resolve_supplier(&tx, supplier_id, supplier_name.as_deref())?;
    let reference_no = match reference_no.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => Some(r.to_string()),
        None => Some(purchase_id.clone()),
    };

    tx.execute(
        "UPDATE purchases SET reference_no = ?1, supplier_id = ?2, supplier_name = ?3,
                purchase_date = ?4, pay_term = ?5, status = ?6, discount_type = ?7,
                discount_amount = ?8, total_amount = ?9
         WHERE id = ?10",
        rusqlite::params![
            reference_no,
            sup_id,
            sup_name,
            purchase_date,
            pay_term,
            status,
            discount_type,
            discount_amount,
            net_total,
            purchase_id
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM purchase_items WHERE purchase_id = ?1",
        [&purchase_id],
    )
    .map_err(|e| e.to_string())?;

    for (i, l) in lines.iter().enumerate() {
        let (net, total, margin) = computed[i];
        let item_id = format!("{}-{}", purchase_id, i + 1);
        tx.execute(
            "INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_type,
                                         quantity, qty_received, unit_cost_raw, discount_percent,
                                         unit_cost_net, line_total, profit_margin_percent,
                                         unit_selling_price, mfg_date, expiry_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                item_id,
                purchase_id,
                l.product_id,
                l.product_name,
                l.unit_type,
                l.quantity,
                l.unit_cost_raw,
                l.discount_percent,
                net,
                total,
                margin,
                l.unit_selling_price,
                l.mfg_date,
                l.expiry_date
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": purchase_id,
        "total": net_total,
        "items": lines.len(),
    }))
}

/// Cancel a Draft/Ordered purchase that won't be fulfilled. Received purchases
/// can't be cancelled (the goods are already in stock); cancelled purchases
/// drop out of the list and the bell.
#[tauri::command]
fn cancel_purchase(
    app: AppHandle,
    purchase_id: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (status, cancelled, ref_no): (String, i64, Option<String>) = tx
        .query_row(
            "SELECT status, cancelled, reference_no FROM purchases WHERE id = ?1",
            [&purchase_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "Purchase not found".to_string())?;
    if cancelled != 0 {
        return Err("Already cancelled".into());
    }
    if status == "Received" {
        return Err(
            "A received purchase can't be cancelled — the goods are already in stock".into(),
        );
    }
    let reason = reason.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    tx.execute(
        "UPDATE purchases SET cancelled = 1, cancel_reason = ?1,
                cancelled_at = datetime('now', 'localtime') WHERE id = ?2",
        rusqlite::params![reason, purchase_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "id": purchase_id, "reference_no": ref_no }))
}

/// Record a payment against a supplier invoice. Balance = total_amount −
/// SUM(payments); overpaying is rejected. Keeps a per-payment history so the
/// "what do I owe" view is auditable.
#[tauri::command]
fn record_payment(
    app: AppHandle,
    purchase_id: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
) -> Result<serde_json::Value, String> {
    if amount <= 0.0 {
        return Err("Payment amount must be positive".into());
    }
    let method = match method.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => m.to_string(),
        None => "Cash".to_string(),
    };
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (total, cancelled, ref_no): (f64, i64, Option<String>) = tx
        .query_row(
            "SELECT total_amount, cancelled, reference_no FROM purchases WHERE id = ?1",
            [&purchase_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "Purchase not found".to_string())?;
    if cancelled != 0 {
        return Err("A cancelled purchase can't be paid".into());
    }
    let paid: f64 = tx
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM purchase_payments WHERE purchase_id = ?1",
            [&purchase_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let amount = (amount * 100.0).round() / 100.0;
    if (paid + amount) - total > 0.005 {
        return Err(format!(
            "Payment of {} exceeds the {} balance left on this invoice",
            amount,
            ((total - paid) * 100.0).round() / 100.0
        ));
    }
    tx.execute(
        "INSERT INTO purchase_payments (purchase_id, amount, method, operator)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![purchase_id, amount, method, operator],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let balance = ((total - paid - amount) * 100.0).round() / 100.0;
    Ok(serde_json::json!({
        "reference_no": ref_no,
        "paid": ((paid + amount) * 100.0).round() / 100.0,
        "balance": balance.max(0.0),
    }))
}

/// Settle a customer's book balance — a payment against what they owe from
/// credit sales. Over-settling is rejected; every payment is kept for audit.
#[tauri::command]
fn settle_credit(
    app: AppHandle,
    patient_name: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
) -> Result<serde_json::Value, String> {
    let name = patient_name.trim().to_string();
    if name.is_empty() {
        return Err("Customer name is required".into());
    }
    if amount <= 0.0 {
        return Err("Payment amount must be positive".into());
    }
    let method = match method.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => m.to_string(),
        None => "Cash".to_string(),
    };
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let owed: f64 = tx
        .query_row(
            "SELECT COALESCE(SUM(sp.amount),0) FROM sale_payments sp
             JOIN sales s ON s.id = sp.sale_id
             WHERE sp.method = 'Credit' AND s.patient_name = ?1 COLLATE NOCASE",
            [&name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let settled: f64 = tx
        .query_row(
            "SELECT COALESCE(SUM(amount),0) FROM credit_payments
             WHERE patient_name = ?1 COLLATE NOCASE",
            [&name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let amount = (amount * 100.0).round() / 100.0;
    if (settled + amount) - owed > 0.005 {
        return Err(format!(
            "Payment of {} exceeds the {} balance {} owes",
            amount,
            ((owed - settled) * 100.0).round() / 100.0,
            name
        ));
    }
    tx.execute(
        "INSERT INTO credit_payments (patient_name, amount, method, operator)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, amount, method, operator],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "patient_name": name,
        "paid": ((settled + amount) * 100.0).round() / 100.0,
        "balance": ((owed - settled - amount) * 100.0).round() / 100.0,
    }))
}

/// Refund part or all of a sale. The SALE STAYS (history integrity — reports
/// subtract returns); stock goes back on the shelf. One transaction: returns
/// + return items + restock, all or nothing. A line can't return more than
/// the sale sold for that product, net of anything already returned on this
/// sale (prevents double refunds). The refund amount is computed here from the
/// original line prices — the client never supplies a total.
#[tauri::command]
fn return_sale(
    app: AppHandle,
    sale_id: i64,
    reason: Option<String>,
    operator: Option<String>,
    lines: Vec<ReturnLine>,
) -> Result<ReturnResult, String> {
    if lines.is_empty() {
        return Err("Nothing to return".into());
    }
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let receipt_no: String = tx
        .query_row(
            "SELECT receipt_no FROM sales WHERE id = ?1",
            [sale_id],
            |r| r.get(0),
        )
        .map_err(|_| "Sale not found".to_string())?;

    // FIFO consumption of the sale's own lines → (product, name, qty, price, unit)
    let mut to_restock: Vec<(i64, String, i64, f64, Option<String>)> = Vec::new();
    let mut total_refunded = 0.0;
    for l in &lines {
        if l.quantity <= 0 {
            return Err("Return quantity must be positive".into());
        }
        let returned: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(sri.quantity), 0)
                 FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id
                 WHERE sr.sale_id = ?1 AND sri.product_id = ?2",
                rusqlite::params![sale_id, l.product_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let sold_rows: Vec<(i64, f64, Option<String>, String)> = tx
            .prepare(
                "SELECT quantity, unit_price, unit, product_name FROM sale_items
                 WHERE sale_id = ?1 AND product_id = ?2 ORDER BY id",
            )
            .map_err(|e| e.to_string())?
            .query_map(rusqlite::params![sale_id, l.product_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let sold: i64 = sold_rows.iter().map(|(q, _, _, _)| q).sum();
        let avail = (sold - returned).max(0);
        if l.quantity > avail {
            return Err(format!(
                "Only {} of that item can be returned on this sale (sold {}, already returned {})",
                avail, sold, returned
            ));
        }
        let mut remaining = l.quantity;
        for (qty, price, unit, name) in &sold_rows {
            if remaining <= 0 {
                break;
            }
            let take = (*qty).min(remaining);
            remaining -= take;
            total_refunded += price * take as f64;
            to_restock.push((l.product_id, name.clone(), take, *price, unit.clone()));
        }
    }

    let _res = tx
        .execute(
            "INSERT INTO sale_returns (sale_id, receipt_no, total_refunded, reason, operator)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![sale_id, receipt_no, total_refunded, reason, operator],
        )
        .map_err(|e| e.to_string())?;
    let return_id = tx.last_insert_rowid();
    for (pid, name, qty, price, unit) in &to_restock {
        tx.execute(
            "INSERT INTO sale_return_items (return_id, product_id, product_name, quantity, unit_price, unit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![return_id, pid, name, qty, price, unit],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty + ?1 WHERE id = ?2",
            rusqlite::params![qty, pid],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ReturnResult {
        receipt_no,
        total_refunded,
        return_id,
    })
}

/// Delete TODAY'S last sale entirely (items, payments, sale) and put the stock
/// back. Guarded by design: only `id = MAX(id)` AND same-day — history stays
/// intact; everything else goes through the return path.
#[tauri::command]
fn void_last_sale(
    app: AppHandle,
    operator: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = operator; // nothing to stamp — the rows are deleted
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let (id, receipt_no, is_today): (i64, String, bool) = tx
        .query_row(
            "SELECT id, receipt_no, date(timestamp) = date('now','localtime')
             FROM sales ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "No sales to void".to_string())?;
    if !is_today {
        return Err("Only today's last sale can be voided".into());
    }

    let items: Vec<(i64, i64)> = tx
        .prepare("SELECT product_id, quantity FROM sale_items WHERE sale_id = ?1")
        .map_err(|e| e.to_string())?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM sale_payments WHERE sale_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sale_items WHERE sale_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sales WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    for (pid, qty) in &items {
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty + ?1 WHERE id = ?2",
            rusqlite::params![qty, pid],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "receipt_no": receipt_no }))
}

/// Manual stock change with a mandatory reason; logged to stock_adjustments.
/// delta is signed (+ in / − out) and the new quantity can never go negative.
#[tauri::command]
fn adjust_stock(
    app: AppHandle,
    product_id: i64,
    delta: i64,
    reason: String,
    operator: Option<String>,
) -> Result<serde_json::Value, String> {
    if reason.trim().is_empty() {
        return Err("A reason is required for stock adjustments".into());
    }
    if delta == 0 {
        return Err("Adjustment can't be zero".into());
    }
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let (name, stock): (String, i64) = tx
        .query_row(
            "SELECT name, stock_qty FROM products WHERE id = ?1",
            [product_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Unknown product".to_string())?;
    let new_stock = stock + delta;
    if new_stock < 0 {
        return Err(format!(
            "Stock can't go below zero (currently {})",
            stock
        ));
    }
    tx.execute(
        "UPDATE products SET stock_qty = stock_qty + ?1 WHERE id = ?2",
        rusqlite::params![delta, product_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO stock_adjustments (product_id, product_name, delta, reason, operator)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![product_id, name, delta, reason.trim(), operator],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "product_id": product_id,
        "delta": delta,
        "new_stock": new_stock,
    }))
}

/// Backup files in backups/, newest first (names are timestamped).
#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "db").unwrap_or(false) {
                if let Ok(meta) = p.metadata() {
                    out.push(BackupInfo {
                        name: p
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        size: meta.len(),
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Swap the live database for a backup file. The current DB is snapshotted to
/// backups/pre-restore-<ts>.db FIRST (safety net), then the file is replaced
/// and stale WAL/SHM sidecars removed. The JS side restarts the app right
/// after — nothing writes through the old connection post-swap.
#[tauri::command]
fn restore_backup(app: AppHandle, name: String) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".db") {
        return Err("Invalid backup name".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let src = dir.join("backups").join(&name);
    if !src.is_file() {
        return Err("Backup not found".into());
    }
    // Must be a real SQLite database.
    let mut header = [0u8; 16];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&src).map_err(|e| e.to_string())?;
        f.read_exact(&mut header)
            .map_err(|_| "Not a valid backup".to_string())?;
    }
    if &header != b"SQLite format 3\0" {
        return Err("Not a valid SQLite backup file".into());
    }
    // Safety net: snapshot the CURRENT live DB before swapping.
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    backup_to_path(
        &db_path(&app)?,
        &dir.join("backups").join(format!("pre-restore-{}.db", epoch)),
    )?;
    // Swap.
    let live = db_path(&app)?;
    fs::copy(&src, &live).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join("pulse.db-wal"));
    let _ = fs::remove_file(dir.join("pulse.db-shm"));
    Ok(format!("Restored {}. Pulse will restart.", name))
}

/// Restart the app immediately (never returns). Used after a backup restore.
#[tauri::command]
fn restart_app(app: AppHandle) -> Result<(), String> {
    app.restart()
}

// ---------------------------------------------------------------------------
// Stock import from the old system (Excel/CSV export)
// ---------------------------------------------------------------------------

/// Read a CSV file into headers + rows. Flexible: quoted fields, variable
/// column counts, leading/trailing whitespace trimmed. Non-UTF-8 bytes fall
/// back to lossy decoding (Ghanaian exports are often Latin-1).
fn parse_csv(path: &str) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let bytes = fs::read(path).map_err(|e| format!("Can't read {}: {}", path, e))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| format!("Bad CSV header in {}: {}", path, e))?
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("Bad CSV row in {}: {}", path, e))?;
        rows.push(rec.iter().map(|s| s.to_string()).collect());
    }
    Ok((headers, rows))
}

/// Read the FIRST sheet of an .xlsx/.xls/.ods workbook into headers + rows.
fn parse_spreadsheet(path: &str) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    use calamine::{open_workbook_auto, Reader};
    let mut wb = open_workbook_auto(path)
        .map_err(|e| format!("Can't open {} as a spreadsheet: {}", path, e))?;
    let sheet = wb
        .sheet_names()
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} has no sheets", path))?;
    let range = wb
        .worksheet_range(&sheet)
        .map_err(|e| format!("Can't read sheet in {}: {}", path, e))?;
    let mut it = range.rows();
    let headers: Vec<String> = match it.next() {
        Some(first) => first.iter().map(|c| c.to_string().trim().to_string()).collect(),
        None => return Err(format!("{}: the sheet is empty", path)),
    };
    let rows: Vec<Vec<String>> = it.map(|r| r.iter().map(|c| c.to_string()).collect()).collect();
    Ok((headers, rows))
}

/// Parse a stock export (CSV or Excel) into headers + raw string rows so the
/// frontend can offer a column-mapping preview. Capped at 5000 rows.
#[tauri::command]
fn parse_stock_file(path: String) -> Result<ParsedSheet, String> {
    const MAX_ROWS: usize = 5000;
    let lower = path.to_lowercase();
    let (headers, mut rows) = if lower.ends_with(".csv") {
        parse_csv(&path)?
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xls") || lower.ends_with(".ods") {
        parse_spreadsheet(&path)?
    } else {
        // Unknown extension: try spreadsheet first, then CSV.
        match parse_spreadsheet(&path) {
            Ok(v) => v,
            Err(_) => parse_csv(&path)?,
        }
    };
    if rows.len() > MAX_ROWS {
        rows.truncate(MAX_ROWS);
    }
    Ok(ParsedSheet { headers, rows })
}

/// Commit mapped stock rows in ONE transaction. Matching rule:
///   1. barcode (trimmed, exact) — the primary key of the old system
///   2. otherwise product name (case-insensitive)
/// A match updates selling/cost price and reorder level when provided, and
/// ADDS the imported quantity to stock. No match creates a new product.
/// Rows with no name are skipped and reported.
#[tauri::command]
fn commit_stock_import(
    app: AppHandle,
    records: Vec<StockImportRow>,
) -> Result<ImportSummary, String> {
    if records.is_empty() {
        return Err("No rows to import".into());
    }
    if records.len() > 5000 {
        return Err("Too many rows — max 5000 per import".into());
    }
    let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut created = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for (i, r) in records.iter().enumerate() {
        let row_no = i + 1;
        let name = r.name.trim().to_string();
        if name.is_empty() {
            skipped += 1;
            if errors.len() < 20 {
                errors.push(format!("Row {}: missing product name", row_no));
            }
            continue;
        }
        let qty = r.stock_qty.unwrap_or(0.0).round() as i64;
        if qty < 0 {
            skipped += 1;
            if errors.len() < 20 {
                errors.push(format!("Row {}: quantity can't be negative", row_no));
            }
            continue;
        }
        let barcode = r.barcode.as_deref().map(str::trim).filter(|s| !s.is_empty());

        let existing: Option<i64> = if let Some(bc) = barcode {
            tx.query_row(
                "SELECT id FROM products WHERE barcode = ?1",
                [bc],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        // Fall back to a name match (case-insensitive) when barcode is
        // missing or didn't hit.
        let existing = existing.or_else(|| {
            tx.query_row(
                "SELECT id FROM products WHERE lower(name) = lower(?1) ORDER BY id LIMIT 1",
                [&name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
            .ok()
            .flatten()
        });

        match existing {
            Some(id) => {
                let mut sets: Vec<String> = Vec::new();
                let mut vals: Vec<rusqlite::types::Value> = Vec::new();
                if let Some(sp) = r.selling_price {
                    vals.push(rusqlite::types::Value::Real(sp));
                    sets.push(format!("selling_price = ?{}", vals.len()));
                }
                if let Some(cp) = r.cost_price {
                    vals.push(rusqlite::types::Value::Real(cp));
                    sets.push(format!("cost_price = ?{}", vals.len()));
                }
                if let Some(rl) = r.reorder_level {
                    vals.push(rusqlite::types::Value::Integer(rl));
                    sets.push(format!("reorder_level = ?{}", vals.len()));
                }
                if qty > 0 {
                    vals.push(rusqlite::types::Value::Integer(qty));
                    sets.push(format!("stock_qty = stock_qty + ?{}", vals.len()));
                }
                if sets.is_empty() {
                    skipped += 1;
                    if errors.len() < 20 {
                        errors.push(format!(
                            "Row {}: '{}' already exists — nothing new to update",
                            row_no, name
                        ));
                    }
                    continue;
                }
                vals.push(rusqlite::types::Value::Integer(id));
                let sql = format!("UPDATE products SET {} WHERE id = ?{}", sets.join(", "), vals.len());
                tx.execute(&sql, rusqlite::params_from_iter(vals.iter()))
                    .map_err(|e| e.to_string())?;
                updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO products (name, barcode, category, manufacturer, supplier, strength, unit, rx_flag, batch_no, expiry_date, cost_price, selling_price, stock_qty, reorder_level, fda_reg_no, is_controlled, active)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1)",
                    rusqlite::params![
                        name,
                        barcode,
                        r.category.as_deref(),
                        r.manufacturer.as_deref(),
                        r.supplier.as_deref(),
                        r.strength.as_deref(),
                        r.unit.as_deref(),
                        r.rx_flag.unwrap_or(0),
                        r.batch_no.as_deref(),
                        r.expiry_date.as_deref(),
                        r.cost_price.unwrap_or(0.0),
                        r.selling_price.unwrap_or(0.0),
                        qty,
                        r.reorder_level.unwrap_or(10),
                        r.fda_reg_no.as_deref(),
                        r.is_controlled.unwrap_or(0),
                    ],
                )
                .map_err(|e| e.to_string())?;
                created += 1;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportSummary {
        created,
        updated,
        skipped,
        errors,
    })
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    (
        "0002_refresh_seed_dates",
        include_str!("../migrations/0002_refresh_seed_dates.sql"),
    ),
    ("0003_units", include_str!("../migrations/0003_units.sql")),
    (
        "0004_requisitions",
        include_str!("../migrations/0004_requisitions.sql"),
    ),
    ("0005_payments", include_str!("../migrations/0005_payments.sql")),
    ("0006_operators", include_str!("../migrations/0006_operators.sql")),
    ("0007_returns", include_str!("../migrations/0007_returns.sql")),
    (
        "0008_stock_adjustments",
        include_str!("../migrations/0008_stock_adjustments.sql"),
    ),
    (
        "0009_patient_sales",
        include_str!("../migrations/0009_patient_sales.sql"),
    ),
    (
        "0010_products_active",
        include_str!("../migrations/0010_products_active.sql"),
    ),
    ("0011_cleanup", include_str!("../migrations/0011_cleanup.sql")),
    ("0012_seed_catalog", include_str!("../migrations/0012_seed_catalog.sql")),
    ("0013_purchasing", include_str!("../migrations/0013_purchasing.sql")),
    (
        "0014_requisition_tools",
        include_str!("../migrations/0014_requisition_tools.sql"),
    ),
    ("0015_credit_ledger", include_str!("../migrations/0015_credit_ledger.sql")),
    ("0016_sales_credit_method", include_str!("../migrations/0016_sales_credit_method.sql")),
    ("0017_sale_payments_credit_method", include_str!("../migrations/0017_sale_payments_credit_method.sql")),
    ("0018_patient_email", include_str!("../migrations/0018_patient_email.sql")),
];

/// Apply pending migrations with PRAGMA user_version as the version tracker.
/// We do NOT rely on tauri-plugin-sql's migration runner: it keys migrations
/// by an internal map that is removed on first load, so pending migrations
/// were never applied on existing databases (only v1 ever recorded). This
/// runner is deterministic: each migration runs in its own transaction and
/// bumps user_version. A "duplicate column name" error is treated as success
/// so an ALTER can be re-run on a database that already has the column.
fn run_migrations(app: &tauri::App) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut conn = rusqlite::Connection::open(dir.join("pulse.db")).map_err(|e| e.to_string())?;
    // Migrations rebuild parent tables (0016/0017) and were written assuming
    // FK enforcement is OFF. SQLite's default is off, but the SQL plugin may
    // leave foreign_keys ON on connections to the same file, so force it OFF
    // here — before the loop, outside any transaction (the pragma is a no-op
    // inside one). Without this, DROP TABLE sales in 0016 fails when
    // sale_returns rows exist (that FK has no ON DELETE CASCADE).
    conn.pragma_update(None, "foreign_keys", "OFF")
        .map_err(|e| e.to_string())?;
    let ver: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    for (i, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let v = (i + 1) as i64;
        if v <= ver {
            continue;
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        match tx.execute_batch(sql) {
            Ok(()) => {
                tx.pragma_update(None, "user_version", v)
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => {
                let msg = e.to_string();
                drop(tx); // rollback
                if msg.contains("duplicate column name") {
                    // Column already exists — treat as applied.
                    let tx2 = conn
                        .transaction_with_behavior(TransactionBehavior::Immediate)
                        .map_err(|e| e.to_string())?;
                    tx2.pragma_update(None, "user_version", v)
                        .map_err(|e| e.to_string())?;
                    tx2.commit().map_err(|e| e.to_string())?;
                } else {
                    return Err(format!("migration {} failed: {}", name, msg));
                }
            }
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            run_migrations(app).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            complete_sale,
            backup_db,
            export_report,
            receive_po,
            return_sale,
            void_last_sale,
            adjust_stock,
            list_backups,
            restore_backup,
            restart_app,
            parse_stock_file,
            commit_stock_import,
            save_purchase,
            receive_purchase,
            update_purchase,
            cancel_purchase,
            record_payment,
            settle_credit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Safety net: back up the database when the app closes.
            if let tauri::RunEvent::Exit = event {
                if let Err(e) = write_backup(app) {
                    eprintln!("exit backup failed: {e}");
                }
            }
        });
}
