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
        if !matches!(p.method.as_str(), "Cash" | "Card" | "MoMo") {
            return Err("Unknown payment method".into());
        }
        if p.amount <= 0.0 {
            return Err(format!("Payment amount for {} must be positive", p.method));
        }
        paid += p.amount;
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

/// Write report rows (already rendered client-side) to a CSV file in exports/.
#[tauri::command]
fn export_report(
    app: AppHandle,
    name: String,
    rows: Vec<Vec<String>>,
) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let edir = dir.join("exports");
    fs::create_dir_all(&edir).map_err(|e| e.to_string())?;

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

    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let safe = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>();
    let dst = edir.join(format!("{}-{}.csv", safe, epoch));
    fs::write(&dst, out).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
pub struct ReceiveLine {
    po_item_id: i64,
    qty: i64,
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
            restart_app
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
