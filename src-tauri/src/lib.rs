use rusqlite::TransactionBehavior;
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
        "INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            receipt_no,
            total,
            primary,
            operator,
            paid,
            change
        ],
    )
    .map_err(|e| e.to_string())?;
    let sale_id = tx.last_insert_rowid();

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
    let src = rusqlite::Connection::open_with_flags(
        &src_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    src.backup(rusqlite::DatabaseName::Main, &dst, None)
        .map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().into_owned())
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
            receive_po
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
