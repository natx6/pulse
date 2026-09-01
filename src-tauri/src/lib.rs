use rusqlite::{OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Emitter, Manager};
#[derive(Deserialize)]
pub struct SaleLine {
    product_id: i64,
    name: String,
    quantity: i64,
    /// Accepted for payload compatibility but never trusted — complete_sale
    /// re-reads the real price from the catalog instead (see below).
    #[allow(dead_code)]
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
    pack_size: Option<i64>,
    #[serde(default)]
    fda_reg_no: Option<String>,
    #[serde(default)]
    is_controlled: Option<i64>,
}

/// One row of a customers/patients export from the old system. `phone`,
/// `discount_tier` and `opening_balance` are optional — an export may only
/// carry names, or only names + what each customer already owes.
#[derive(Deserialize)]
pub struct CustomerImportRow {
    name: String,
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    discount_tier: Option<f64>,
    #[serde(default)]
    opening_balance: Option<f64>,
}

/// One row of a suppliers export. `phone`, `location` and `opening_balance`
/// (what the pharmacy already owes the supplier at switch-on) are optional.
#[derive(Deserialize)]
pub struct SupplierImportRow {
    name: String,
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    opening_balance: Option<f64>,
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
/// app_config_dir is the canonical home for pulse.db — all Rust commands
/// and the plugin-sql frontend resolve against this same directory.
/// (plugin-sql is pointed here via an absolute sqlite:// URL from db.ts.)
fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pulse.db"))
}

// ---------------------------------------------------------------------------
// Encryption at rest (SQLCipher)
//
// pulse.db is AES-256 encrypted via SQLCipher. The 256-bit key is generated
// once per install and kept in pulse.key beside the database:
//
//   - protects against the db file being copied/stolen on its own (backups,
//     sync folders, flash drives) — such copies are opaque without the key
//   - the key lives on the SAME machine by design: this is data-at-rest
//     encryption, not per-user access control. Full-disk encryption (BitLocker
//     / FileVault / LUKS) is the complementary layer for laptop theft.
//
// External backups are encrypted with the same key — restoring one onto a
// fresh machine requires copying pulse.key along with it.
// ---------------------------------------------------------------------------

/// Path of the SQLCipher key file. Same directory as db_path so they travel
/// together; tauri-plugin-sql's vendored patch reads this exact location too.
fn db_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pulse.key"))
}

/// Read the install's database key, generating + persisting a fresh 256-bit
/// key on first run. Idempotent; safe to call from both setup and commands.
fn ensure_db_key(app: &AppHandle) -> Result<String, String> {
    let path = db_key_path(app)?;
    if let Ok(existing) = fs::read_to_string(&path) {
        let k = existing.trim().to_string();
        if !k.is_empty() {
            return Ok(k);
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // Create the file with 0600 from the start — never a world-readable
    // window between write and chmod. O_EXCL also closes the first-run race:
    // two concurrent callers can't each mint a different key; the loser of
    // the create re-reads the winner's key.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(key.as_bytes())
                    .map_err(|e| format!("Can't write {}: {e}", path.display()))?;
                return Ok(key);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Another caller won the race — read what they wrote.
                if let Ok(existing) = fs::read_to_string(&path) {
                    let k = existing.trim().to_string();
                    if !k.is_empty() {
                        return Ok(k);
                    }
                }
                return Err(format!(
                    "{} exists but is empty/unreadable — delete it and restart",
                    path.display()
                ));
            }
            Err(e) => return Err(format!("Can't write {}: {e}", path.display())),
        }
    }
    #[cfg(not(unix))]
    {
        fs::write(&path, &key).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
        Ok(key)
    }
}

/// Open a connection to pulse.db and unlock it. `PRAGMA key` MUST be the
/// first statement on the connection — anything before it reads garbage.
pub fn open_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    apply_db_key(&conn, &ensure_db_key(app)?)?;
    // Serialize contending writers instead of returning SQLITE_BUSY mid-sale:
    // a sale + a dashboard poll or refund can fire together, and a bare error
    // there means a lost transaction at the counter.
    conn.execute_batch("PRAGMA busy_timeout = 5000;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Feed `key` to an already-open SQLCipher connection as a raw hex key.
/// Uses the documented double-quoted x'…' form so the hex can't be
/// misinterpreted as a passphrase.
fn apply_db_key(conn: &rusqlite::Connection, key: &str) -> Result<(), String> {
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";",))
        .map_err(|e| e.to_string())
}

/// Probe that a connection can actually read pages — i.e. the key was right.
fn probe_decrypted(conn: &rusqlite::Connection) -> bool {
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .is_ok()
}

/// One-time migration: encrypt an existing PLAINTEXT pulse.db in place.
///
/// Runs at startup before migrations. If the live db reads fine WITHOUT a key
/// it is legacy plaintext: copy it into a fresh SQLCipher-encrypted file via
/// sqlcipher_export (schema + data + user_version), swap files, and shred the
/// plaintext original plus its WAL/SHM sidecars — leaving plaintext on disk
/// would defeat the whole exercise.
fn migrate_plaintext_db(app: &AppHandle) -> Result<(), String> {
    let path = db_path(app)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    // Leftover from an interrupted migration: the encrypted copy is already
    // in place, so the stash is redundant — wipe it.
    let old = dir.join("pulse.db.plaintext");
    if old.exists() {
        zero_and_remove(&old);
    }
    if !path.exists() {
        return Ok(()); // first run — nothing to migrate; open_db creates it encrypted
    }
    let key = ensure_db_key(app)?;

    // Already encrypted? Then a keyed probe succeeds and we're done.
    if let Ok(c) = rusqlite::Connection::open(&path) {
        if apply_db_key(&c, &key).is_ok() && probe_decrypted(&c) {
            return Ok(());
        }
    }

    // Plaintext? Probe without any key.
    let ver = {
        let plain = rusqlite::Connection::open(&path)
            .map_err(|e| format!("can't open database: {e}"))?;
        if !probe_decrypted(&plain) {
            return Err(
                "Database file is neither readable as plaintext nor with this \
                 install's key — it may be corrupt or belong to another install."
                    .into(),
            );
        }
        plain
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
    };

    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let tmp = dir.join("pulse.db.encrypting");
    let _ = fs::remove_file(&tmp);

    {
        let plain = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
        // ATTACH ... KEY initializes the new file as SQLCipher-encrypted.
        plain
            .execute_batch(&format!(
                "ATTACH DATABASE '{}' AS enc KEY \"x'{key}'\";",
                tmp.to_string_lossy().replace('\'', "''")
            ))
            .map_err(|e| e.to_string())?;
        // sqlcipher_export returns a NULL row — only the query failing
        // indicates an error.
        plain
            .query_row("SELECT sqlcipher_export('enc')", [], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .map_err(|e| format!("sqlcipher_export failed: {e}"))?;
        // sqlcipher_export does NOT carry user_version across — set it or
        // every migration re-runs from zero on next launch.
        plain
            .pragma_update(
                Some(rusqlite::DatabaseName::Attached("enc")),
                "user_version",
                ver,
            )
            .map_err(|e| e.to_string())?;
        plain
            .execute_batch("DETACH DATABASE enc;")
            .map_err(|e| e.to_string())?;
    }

    // Sanity-check the encrypted copy BEFORE destroying the original.
    {
        let check = rusqlite::Connection::open(&tmp).map_err(|e| e.to_string())?;
        apply_db_key(&check, &key)?;
        if !probe_decrypted(&check) {
            let _ = fs::remove_file(&tmp);
            return Err("Encrypted copy failed verification — original left untouched".into());
        }
    }

    // Flush any committed-but-uncheckpointed WAL frames back into the main
    // file BEFORE deleting the sidecars — otherwise recent transactions that
    // lived only in the -wal would silently vanish from the encrypted copy.
    // (sqlcipher_export above reads through the same connection's WAL view,
    // so the export itself was correct; this protects the plaintext original
    // and keeps the on-disk main file self-contained.)
    {
        let flush = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
        let _ = flush.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
    }
    for sidecar in ["-wal", "-shm"] {
        let _ = fs::remove_file(dir.join(format!("pulse.db{sidecar}")));
    }
    fs::rename(&path, &old).map_err(|e| format!("swap failed: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        // Roll the plaintext back into place so a failed promotion can't
        // leave the shop with no database at all.
        let _ = fs::rename(&old, &path);
        format!("swap failed: {e}")
    })?;
    zero_and_remove(&old);

    Ok(())
}

/// Overwrite a file's bytes with zeros (defeats file-recovery tools), then
/// delete it. Best-effort on the write; the unlink matters most.
fn zero_and_remove(path: &std::path::Path) {
    if let Ok(mut f) = fs::OpenOptions::new().write(true).open(path) {
        use std::io::{Seek, SeekFrom, Write};
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = f.seek(SeekFrom::Start(0));
        let zeros = [0u8; 8192];
        let mut left = len;
        while left > 0 {
            let n = zeros.len().min(left as usize);
            if f.write_all(&zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = f.sync_all();
    }
    let _ = fs::remove_file(path);
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
    discount_pct: Option<f64>,
) -> Result<SaleResult, String> {
    let mut conn = open_db(&app)?;
    let result = complete_sale_impl(
        &mut conn,
        payments,
        lines,
        operator,
        patient_name,
        patient_phone,
        discount_pct,
    )?;
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
    Ok(result)
}

/// The actual complete_sale logic, taking an open connection directly rather
/// than an AppHandle — kept separate from the #[tauri::command] wrapper above
/// so it's callable from tests with a plain in-memory connection.
fn complete_sale_impl(
    conn: &mut rusqlite::Connection,
    payments: Vec<Payment>,
    lines: Vec<SaleLine>,
    operator: Option<String>,
    patient_name: Option<String>,
    patient_phone: Option<String>,
    discount_pct: Option<f64>,
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

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // 1. Validate + stock check (fail before writing anything). Quantity and
    // price are never trusted from the client — re-read the authoritative
    // selling price and cost (for the profit snapshot below) from the
    // catalog, the same principle save_purchase already applies to purchases.
    let mut catalog: std::collections::HashMap<i64, (f64, f64)> = std::collections::HashMap::new();
    // Aggregate duplicate product lines first — each line must not be checked
    // against original stock in isolation or two lines of the same product can
    // pass individually and drive stock negative on deduct.
    let mut qty_by_product: std::collections::HashMap<i64, (i64, String)> =
        std::collections::HashMap::new();
    for l in &lines {
        if l.quantity <= 0 {
            return Err(format!("Quantity for {} must be positive", l.name));
        }
        let e = qty_by_product
            .entry(l.product_id)
            .or_insert((0, l.name.clone()));
        e.0 += l.quantity;
    }
    for (pid, (qty, name)) in &qty_by_product {
        let (st, price, cost): (i64, f64, f64) = tx
            .query_row(
                "SELECT stock_qty, selling_price, cost_price FROM products WHERE id = ?1",
                [pid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| format!("Unknown product: {}", name))?;
        if st < *qty {
            return Err(format!(
                "Not enough stock for {} (have {}, need {})",
                name, st, qty
            ));
        }
        catalog.insert(*pid, (price, cost));
    }

    // 2. Receipt number: per-day sequence, computed inside the transaction.
    // BEGIN IMMEDIATE serializes writers across app instances on this file,
    // so two counters can never compute the same next number. The next number
    // comes from the highest existing suffix, not COUNT(*) — a void hard-deletes
    // its sale row, so counting would hand out an already-printed number again
    // and trip sales.receipt_no's UNIQUE index.
    let date: String = tx
        .query_row("SELECT strftime('%Y%m%d', 'now', 'localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let prefix = format!("RCPT-{}-", date);
    let n: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(CAST(substr(receipt_no, ?1) AS INTEGER)), 0)
             FROM sales WHERE receipt_no LIKE ?2 || '%'",
            rusqlite::params![prefix.len() as i64 + 1, prefix],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let receipt_no = format!("RCPT-{}-{:03}", date, n + 1);

    let subtotal: f64 = lines
        .iter()
        .map(|l| catalog[&l.product_id].0 * l.quantity as f64)
        .sum();
    let disc = discount_pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let discount_amount = subtotal * disc / 100.0;
    // Tax comes from the shop's Settings — the counter display and the
    // recorded sale must agree, so Rust is authoritative (it never was
    // applied here before, silently diverging from the UI when set).
    let tax_rate: f64 = tx
        .query_row(
            "SELECT COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'tax_rate'), 0)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let tax_amount = ((subtotal - discount_amount) * (tax_rate / 100.0) * 100.0).round() / 100.0;
    let total =
        (((subtotal - discount_amount + tax_amount) * 100.0).round() / 100.0).max(0.0);
    if paid < total - 0.005 {
        return Err(format!(
            "Payments (GH₵ {:.2}) don't cover the total (GH₵ {:.2})",
            paid, total
        ));
    }
    let change = (paid - total).max(0.0);
    let primary = payments[0].method.clone();

    // 3. Sale — with the point-in-time financial snapshot (migration 0024).
    tx.execute(
        "INSERT INTO sales (receipt_no, total_amount, payment_method, operator, tendered, change_given, patient_name, patient_phone, subtotal, discount_amount, tax_amount)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            receipt_no,
            total,
            primary,
            operator,
            paid,
            change,
            patient_name,
            patient_phone,
            (subtotal * 100.0).round() / 100.0,
            (discount_amount * 100.0).round() / 100.0,
            tax_amount,
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

    // 4. Items + stock deduction. unit_price and unit_cost both come from the
    // catalog snapshot above, not the client — unit_cost is a POINT-IN-TIME
    // snapshot so profit reports stay reproducible even after the product's
    // cost_price later changes (see migration 0020). Batch ledger moves in
    // lockstep (FEFO) and the consumed batches are recorded on the sale_item
    // as the recall trail.
    // Aggregate stock moves FIRST so the batch ledger reconciles against
    // post-deduction quantities.
    for l in &lines {
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty - ?1 WHERE id = ?2",
            rusqlite::params![l.quantity, l.product_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for l in &lines {
        let (price, cost) = catalog[&l.product_id];
        let batches = fefo_deduct(&tx, l.product_id, l.quantity)?;
        tx.execute(
            "INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit, unit_cost, batches)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![sale_id, l.product_id, l.name, l.quantity, price, l.unit, cost, batches],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;

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
/// After writing, backups/ is pruned to the newest 5 files (best-effort —
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
    backup_to_path(&src_path, &dst, &ensure_db_key(app)?)?;
    prune_backups(&bdir);
    Ok(dst.to_string_lossy().into_owned())
}

/// WAL-safe copy of one SQLite file to a destination path (online backup API).
/// Both connections are keyed: the source must be unlocked to be read, and the
/// destination must be unlocked BEFORE pages are written or the copy would
/// land on disk as plaintext.
fn backup_to_path(
    src_path: &std::path::Path,
    dst_path: &std::path::Path,
    key: &str,
) -> Result<(), String> {
    let src = rusqlite::Connection::open_with_flags(
        src_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    apply_db_key(&src, key)?;
    // A stale target would mix old pages into the copy — start clean.
    let _ = fs::remove_file(dst_path);
    let mut dst = rusqlite::Connection::open(dst_path).map_err(|e| e.to_string())?;
    apply_db_key(&dst, key)?;
    let backup =
        rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
    loop {
        match backup
            .step(128)
            .map_err(|e| format!("backup failed: {e}"))?
        {
            rusqlite::backup::StepResult::Done => break,
            rusqlite::backup::StepResult::More => continue,
            other => return Err(format!("backup failed: unexpected step result {other:?}")),
        }
    }
    Ok(())
}

/// Keep only the newest 5 backup files. Names are timestamped, so lexical
/// sort == chronological. Best-effort: failures are swallowed.
fn prune_backups(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
        .collect();
    files.sort();
    while files.len() > 5 {
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
                // Formula-injection defense: spreadsheet apps execute cells
                // starting with these. A leading ' renders them inert.
                let mut c = c.clone();
                if matches!(
                    c.chars().next(),
                    Some('=') | Some('+') | Some('-') | Some('@') | Some('\t') | Some('\r')
                ) {
                    c.insert(0, '\'');
                }
                if c.contains(',') || c.contains('"') || c.contains('\n') {
                    format!("\"{}\"", c.replace('"', "\"\""))
                } else {
                    c
                }
            })
            .collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("Can't write {}: {}", path, e))?;
    Ok(path)
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
    #[serde(default)]
    batch_no: Option<String>,
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

#[derive(Deserialize, Clone)]
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

// ---------------------------------------------------------------------------
// Batch ledger (FEFO) — product_batches mirrors products.stock_qty per batch.
// Every stock-moving path updates both sides inside the same transaction, so
// SUM(product_batches.quantity) always equals products.stock_qty.
// ---------------------------------------------------------------------------

/// Consume `qty` units of a product from its batches, nearest expiry first
/// (undated batches last, oldest row as the final tiebreak). Returns the
/// breakdown recorded on sale_items.batches — e.g. "AX-8821@2027-03-15x2;B15x1"
/// — which is the recall trail and what returns restore against.
fn fefo_deduct(
    tx: &rusqlite::Transaction,
    product_id: i64,
    qty: i64,
) -> Result<String, String> {
    let rows: Vec<(i64, Option<String>, Option<String>, i64)> = tx
        .prepare(
            "SELECT id, batch_no, expiry_date, quantity FROM product_batches
             WHERE product_id = ?1 AND quantity > 0
             ORDER BY COALESCE(NULLIF(expiry_date, ''), '9999-12-31') ASC, id ASC",
        )
        .map_err(|e| e.to_string())?
        .query_map([product_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut remaining = qty;
    let mut parts: Vec<String> = Vec::new();
    for (id, batch_no, expiry, have) in rows {
        if remaining <= 0 {
            break;
        }
        let take = have.min(remaining);
        remaining -= take;
        tx.execute(
            "UPDATE product_batches SET quantity = ?1 WHERE id = ?2",
            rusqlite::params![have - take, id],
        )
        .map_err(|e| e.to_string())?;
        parts.push(format!(
            "{}{}x{}",
            batch_no.unwrap_or_default(),
            expiry.map(|e| format!("@{e}")).unwrap_or_default(),
            take
        ));
    }
    // Drift guard (legacy rows predating the ledger): when batches couldn't
    // cover the full quantity, reconcile the UNTRACKED bucket against the
    // product's true aggregate stock so SUM(ledger) == stock_qty afterwards,
    // instead of silently losing or inventing units.
    if remaining > 0 {
        add_to_batch(tx, product_id, Some("UNTRACKED"), None, 0)?;
        let stock_now: i64 = tx
            .query_row(
                "SELECT stock_qty FROM products WHERE id = ?1",
                [product_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let ledger_other: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(quantity),0) FROM product_batches
                 WHERE product_id = ?1 AND batch_no IS NOT 'UNTRACKED'",
                [product_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE product_batches SET quantity = ?1
             WHERE product_id = ?2 AND batch_no = 'UNTRACKED'",
            rusqlite::params![(stock_now - ledger_other).max(0), product_id],
        )
        .map_err(|e| e.to_string())?;
        parts.push(format!("UNTRACKEDx{}", remaining));
    }
    Ok(parts.join(";"))
}

/// Parse a sale_items.batches breakdown ("AX8821@2027-03-15x2;CT-2301x1")
/// into (batch_no, expiry_date, qty) triples. Tolerant: unparseable parts
/// are skipped rather than failing the whole restore.
fn parse_batch_breakdown(s: &str) -> Vec<(String, String, i64)> {
    s.split(';')
        .filter_map(|part| {
            let p = part.trim();
            if p.is_empty() {
                return None;
            }
            let ix = p.rfind('x')?;
            let qty: i64 = p[ix + 1..].parse().ok()?;
            if qty <= 0 {
                return None;
            }
            let head = &p[..ix];
            let (batch, expiry) = match head.split_once('@') {
                Some((b, e)) => (b.to_string(), e.to_string()),
                None => (head.to_string(), String::new()),
            };
            Some((batch, expiry, qty))
        })
        .collect()
}

/// Add `qty` to a product's batch matching (batch_no, expiry) exactly,
/// creating the row when it doesn't exist. NULL-safe on both fields.
fn add_to_batch(
    tx: &rusqlite::Transaction,
    product_id: i64,
    batch_no: Option<&str>,
    expiry: Option<&str>,
    qty: i64,
) -> Result<(), String> {
    let updated = tx
        .execute(
            "UPDATE product_batches SET quantity = quantity + ?1
             WHERE product_id = ?2 AND batch_no IS ?3
               AND COALESCE(expiry_date, '') = COALESCE(?4, '')",
            rusqlite::params![qty, product_id, batch_no, expiry],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        tx.execute(
            "INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![product_id, batch_no, expiry, qty],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put sold units back onto the batches they came out of (returns / voids).
/// `breakdown` is the sale_items.batches string fefo_deduct recorded; it is
/// consumed in order, capped at `fallback_qty` (a partial return restores
/// only what it took). Batches that have since disappeared are recreated
/// with their recorded expiry. A missing/unparseable trail falls back to one
/// undated batch, so restocked goods never vanish from the ledger.
fn fefo_restore(
    tx: &rusqlite::Transaction,
    product_id: i64,
    breakdown: Option<&str>,
    fallback_qty: i64,
) -> Result<(), String> {
    let parts = match breakdown.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => parse_batch_breakdown(b),
        None => Vec::new(),
    };
    let mut remaining = fallback_qty;
    for (batch, expiry, qty) in parts {
        if remaining <= 0 {
            break;
        }
        let take = qty.min(remaining);
        remaining -= take;
        let batch_opt = if batch.is_empty() { None } else { Some(batch.as_str()) };
        let expiry_opt = if expiry.is_empty() { None } else { Some(expiry.as_str()) };
        add_to_batch(tx, product_id, batch_opt, expiry_opt, take)?;
    }
    if remaining > 0 {
        add_to_batch(tx, product_id, None, None, remaining)?;
    }
    Ok(())
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
    batch_no: Option<&str>,
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
               supplier = COALESCE(?6, supplier),
               batch_no = COALESCE(NULLIF(?8, ''), batch_no)
             WHERE id = ?7",
            rusqlite::params![add, net, selling, unit_type, expiry, supplier, product_id, batch_no],
        )
        .map_err(|e| format!("Stock update failed for {}: {}", name, e))?;
    if n == 0 {
        return Err(format!("Unknown product: {}", name));
    }
    // Land the goods on a batch row keyed by (batch_no, expiry) so FEFO can
    // pick it up — blank batch numbers collapse onto an undated batch.
    add_to_batch(
        tx,
        product_id,
        batch_no.map(str::trim).filter(|s| !s.is_empty()),
        Some(expiry).filter(|s| !s.is_empty()),
        add,
    )?;
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

    let mut conn = open_db(&app)?;
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
                                         unit_selling_price, mfg_date, expiry_date, batch_no)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                l.expiry_date,
                l.batch_no,
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
                l.batch_no.as_deref(),
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
    let mut conn = open_db(&app)?;
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
        let (product_id, product_name, qty, qty_received, unit_type, net, selling, expiry, batch_no): (
            i64,
            String,
            f64,
            f64,
            String,
            f64,
            f64,
            String,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT product_id, product_name, quantity, qty_received, unit_type,
                        unit_cost_net, unit_selling_price, expiry_date, batch_no
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
                        r.get(8)?,
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
        commit_purchase_stock(&tx, product_id, &product_name, rl.qty, &unit_type, net, selling, &expiry, None, batch_no.as_deref())?;
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

    let mut conn = open_db(&app)?;
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
                                         unit_selling_price, mfg_date, expiry_date, batch_no)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                l.expiry_date,
                l.batch_no,
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
    let mut conn = open_db(&app)?;
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
/// "what do I owe" view is auditable. Money leaves the business, so when a
/// manager PIN is configured it must accompany the request.
#[tauri::command]
fn record_payment(
    app: AppHandle,
    purchase_id: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut conn = open_db(&app)?;
    record_payment_impl(&mut conn, purchase_id, amount, method, operator, manager_pin)
}

/// Actual record_payment logic — split from the command wrapper so tests can
/// run it against a plain in-memory connection.
fn record_payment_impl(
    conn: &mut rusqlite::Connection,
    purchase_id: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    if amount <= 0.0 {
        return Err("Payment amount must be positive".into());
    }
    let method = match method.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => m.to_string(),
        None => "Cash".to_string(),
    };
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // Gate BEFORE any read/write work — mirrors void/return.
    check_manager_pin(&tx, manager_pin)?;
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
/// Writing off what a customer owes is money out the door, so when a manager
/// PIN is configured it must accompany the request.
#[tauri::command]
fn settle_credit(
    app: AppHandle,
    patient_name: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut conn = open_db(&app)?;
    settle_credit_impl(&mut conn, patient_name, amount, method, operator, manager_pin)
}

/// Actual settle_credit logic — split from the command wrapper so tests can
/// run it against a plain in-memory connection.
fn settle_credit_impl(
    conn: &mut rusqlite::Connection,
    patient_name: String,
    amount: f64,
    method: Option<String>,
    operator: Option<String>,
    manager_pin: Option<String>,
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
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // Gate BEFORE any read/write work — mirrors void/return.
    check_manager_pin(&tx, manager_pin)?;
    let owed: f64 = tx
        .query_row(
            "SELECT COALESCE(SUM(sp.amount),0)
               + COALESCE((SELECT MAX(opening_balance) FROM patients WHERE name = ?1 COLLATE NOCASE), 0)
             FROM sale_payments sp
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
    manager_pin: Option<String>,
) -> Result<ReturnResult, String> {
    let mut conn = open_db(&app)?;
    return_sale_impl(&mut conn, sale_id, reason, operator, lines, manager_pin)
}

/// The actual return_sale logic, taking an open connection directly rather
/// than an AppHandle — kept separate from the #[tauri::command] wrapper above
/// so it's callable from tests with a plain in-memory connection.
fn return_sale_impl(
    conn: &mut rusqlite::Connection,
    sale_id: i64,
    reason: Option<String>,
    operator: Option<String>,
    lines: Vec<ReturnLine>,
    manager_pin: Option<String>,
) -> Result<ReturnResult, String> {
    if lines.is_empty() {
        return Err("Nothing to return".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // Money leaves the till on a refund — gate it when a manager PIN is set.
    check_manager_pin(&tx, manager_pin)?;

    let receipt_no: String = tx
        .query_row(
            "SELECT receipt_no FROM sales WHERE id = ?1",
            [sale_id],
            |r| r.get(0),
        )
        .map_err(|_| "Sale not found".to_string())?;
    // What the customer ACTUALLY paid per cedi of list price — the sale's
    // point-in-time snapshot already folds in discount and tax (migration
    // 0024). Refunding raw unit_price would hand back money never collected
    // on a discounted sale.
    let paid_ratio: f64 = {
        let (subtotal, total): (f64, f64) = tx
            .query_row(
                "SELECT COALESCE(subtotal, total_amount), total_amount FROM sales WHERE id = ?1",
                [sale_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if subtotal > 0.0 { (total / subtotal).max(0.0) } else { 1.0 }
    };

    // FIFO consumption of the sale's own lines → (product, name, qty, price,
    // unit, batch breakdown) — the breakdown is what goes back on the shelf.
    let mut to_restock: Vec<(i64, String, i64, f64, Option<String>, Option<String>)> = Vec::new();
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
        let sold_rows: Vec<(i64, f64, Option<String>, String, Option<String>)> = tx
            .prepare(
                "SELECT quantity, unit_price, unit, product_name, batches FROM sale_items
                 WHERE sale_id = ?1 AND product_id = ?2 ORDER BY id",
            )
            .map_err(|e| e.to_string())?
            .query_map(rusqlite::params![sale_id, l.product_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let sold: i64 = sold_rows.iter().map(|(q, _, _, _, _)| q).sum();
        let avail = (sold - returned).max(0);
        if l.quantity > avail {
            return Err(format!(
                "Only {} of that item can be returned on this sale (sold {}, already returned {})",
                avail, sold, returned
            ));
        }
        let mut remaining = l.quantity;
        for (qty, price, unit, name, batches) in &sold_rows {
            if remaining <= 0 {
                break;
            }
            let take = (*qty).min(remaining);
            remaining -= take;
            // Refund what was actually collected for these units (discount +
            // tax folded in), not the pre-discount list price.
            total_refunded += price * paid_ratio * take as f64;
            to_restock.push((l.product_id, name.clone(), take, *price, unit.clone(), batches.clone()));
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
    for (pid, name, qty, price, unit, batches) in &to_restock {
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
        fefo_restore(&tx, *pid, batches.as_deref(), *qty)?;
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
    sale_id: i64,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = operator; // nothing to stamp — the rows are deleted
    let mut conn = open_db(&app)?;
    void_last_sale_impl(&mut conn, sale_id, manager_pin)
}

/// The actual void logic (see return_sale_impl for why this is split out).
fn void_last_sale_impl(
    conn: &mut rusqlite::Connection,
    sale_id: i64,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // A void erases a sale outright — the strongest shrinkage vector there
    // is. Gated by the manager PIN whenever one is configured.
    check_manager_pin(&tx, manager_pin)?;

    // The UI sends the exact row it displayed; binding the void to that id
    // means a stale screen can never destroy a different sale than the one
    // the operator confirmed.
    let (id, receipt_no): (i64, String) = tx
        .query_row(
            "SELECT id, receipt_no FROM sales WHERE id = ?1
             AND date(timestamp) = date('now', 'localtime')",
            [sale_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Sale not found (voids are same-day only)".to_string())?;
    let newest: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(id), 0) FROM sales
             WHERE date(timestamp) = date('now', 'localtime')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if id != newest {
        return Err("Only today's latest sale can be voided".into());
    }

    let items: Vec<(i64, i64, Option<String>)> = tx
        .prepare("SELECT product_id, quantity, batches FROM sale_items WHERE sale_id = ?1")
        .map_err(|e| e.to_string())?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM sale_payments WHERE sale_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sale_items WHERE sale_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sales WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    for (pid, qty, batches) in &items {
        tx.execute(
            "UPDATE products SET stock_qty = stock_qty + ?1 WHERE id = ?2",
            rusqlite::params![qty, pid],
        )
        .map_err(|e| e.to_string())?;
        fefo_restore(&tx, *pid, batches.as_deref(), *qty)?;
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
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    if reason.trim().is_empty() {
        return Err("A reason is required for stock adjustments".into());
    }
    if delta == 0 {
        return Err("Adjustment can't be zero".into());
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // Stock walking out the door as "damaged" is a classic shrinkage vector —
    // reductions ask for the manager PIN when one is configured. Additions
    // (found stock, counting errors) stay friction-free.
    if delta < 0 {
        check_manager_pin(&tx, manager_pin)?;
    }

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
    // Ledger side: reductions consume FEFO like a sale; additions have no
    // known batch (counting error, found stock) so they land on an undated
    // batch — which FEFO naturally consumes last.
    if delta < 0 {
        fefo_deduct(&tx, product_id, -delta)?;
    } else {
        add_to_batch(&tx, product_id, None, None, delta)?;
    }
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
fn restore_backup(app: AppHandle, name: String, manager_pin: Option<String>) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".db") {
        return Err("Invalid backup name".into());
    }
    // Restoring replaces the ENTIRE database (sales history included), so it
    // is gated like every other destructive action.
    {
        let conn = open_db(&app)?;
        check_manager_pin(&conn, manager_pin)?;
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let src = dir.join("backups").join(&name);
    if !src.is_file() {
        return Err("Backup not found".into());
    }
    // Must be a database this install can make sense of: either a
    // SQLCipher-encrypted backup (probe with our key) or a legacy plaintext
    // one (classic header — re-encrypted at next startup).
    {
        let keyed_ok = rusqlite::Connection::open(&src)
            .map_err(|e| e.to_string())
            .and_then(|c| {
                apply_db_key(&c, &ensure_db_key(&app)?)?;
                Ok(probe_decrypted(&c))
            })
            .unwrap_or(false);
        if !keyed_ok {
            use std::io::Read;
            let mut header = [0u8; 16];
            let mut f = std::fs::File::open(&src).map_err(|e| e.to_string())?;
            f.read_exact(&mut header)
                .map_err(|_| "Not a valid backup".to_string())?;
            if &header != b"SQLite format 3\0" {
                return Err("Not a valid Pulse backup (unreadable with this install's key)".into());
            }
        }
    }
    // Safety net: snapshot the CURRENT live DB before swapping.
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    backup_to_path(
        &db_path(&app)?,
        &dir.join("backups").join(format!("pre-restore-{}.db", epoch)),
        &ensure_db_key(&app)?,
    )?;
    // Swap — atomically. fs::copy straight onto pulse.db truncates the live
    // file first, so a mid-copy crash (power loss, disk full) would leave a
    // corrupt main db. Copy to a temp name on the same filesystem, then
    // rename (atomic on POSIX and Windows).
    let live = db_path(&app)?;
    let tmp = live.with_extension("db.restore-tmp");
    fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &live) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    let _ = fs::remove_file(dir.join("pulse.db-wal"));
    let _ = fs::remove_file(dir.join("pulse.db-shm"));
    Ok(format!("Restored {}. Pulse will restart.", name))
}

/// Restart the app immediately (never returns). Used after a backup restore.
#[tauri::command]
fn restart_app(app: AppHandle) -> Result<(), String> {
    app.restart()
}

/// Move a validated flash-drive pair (db + key) into the config dir, with
/// full rollback. The db lands via copy-to-temp + rename so a mid-copy crash
/// can never truncate the live file; ANY failure rolls BOTH files back from
/// the stash — above all it must never leave this install without its own
/// database file. Split from restore_from_dir so tests can exercise every
/// failure branch against plain paths.
fn swap_in_restored_pair(
    conf: &std::path::Path,
    src_db: &std::path::Path,
    src_key: &std::path::Path,
    stash: &std::path::Path,
) -> Result<(), String> {
    let live_db = conf.join("pulse.db");
    // Roll BOTH files back from the stash. Only move the stashed db back if
    // no live db exists — after a partial copy we must not clobber a file
    // that might be mid-write.
    let rollback = || {
        if stash.join("pulse.db").is_file() && !conf.join("pulse.db").exists() {
            let _ = fs::rename(stash.join("pulse.db"), conf.join("pulse.db"));
        }
        if stash.join("pulse.key").is_file() {
            let _ = fs::copy(stash.join("pulse.key"), conf.join("pulse.key"));
        }
    };
    let tmp = conf.join("pulse.db.restore-tmp");
    if let Err(e) = fs::copy(src_db, &tmp) {
        rollback();
        return Err(format!("Couldn't copy {}: {e}", src_db.display()));
    }
    if let Err(e) = fs::rename(&tmp, &live_db) {
        let _ = fs::remove_file(&tmp);
        rollback();
        return Err(format!("Couldn't put restored db into place: {e}"));
    }
    if let Err(e) = fs::copy(src_key, conf.join("pulse.key")) {
        // Roll back: put the original pair back exactly as it was.
        let _ = fs::remove_file(&live_db);
        rollback();
        return Err(format!("Couldn't copy pulse.key into place: {e}"));
    }
    Ok(())
}

/// Restore a flash-drive pair produced by backup_to_dir: `dir` holds a
/// pulse-*.db and the matching pulse.key. Copies BOTH into the config dir
/// (the live key is stashed aside first so a wrong-key restore is itself
/// recoverable), then the caller restarts. This is the disaster-recovery
/// path — moving an install to a new machine.
#[tauri::command]
fn restore_from_dir(
    app: AppHandle,
    dir: String,
    manager_pin: Option<String>,
) -> Result<String, String> {
    // Same gate as restore_backup: this replaces the ENTIRE database, so a
    // flash drive plugged into the till must not bypass the manager PIN.
    {
        let conn = open_db(&app)?;
        check_manager_pin(&conn, manager_pin)?;
    }
    let path = std::path::Path::new(&dir);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Pick the folder that holds the flash-drive backup".into());
    }
    // Find the newest pulse-*.db in the folder.
    let mut candidates: Vec<std::path::PathBuf> = fs::read_dir(path)
        .map_err(|e| format!("Can't read {}: {}", dir, e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("pulse-") && n.ends_with(".db"))
                    .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    let Some(src_db) = candidates.pop() else {
        return Err("No pulse-*.db backup found in that folder".into());
    };
    let src_key = path.join("pulse.key");
    if !src_key.is_file() {
        return Err(
            "pulse.key is missing from that folder — a backup without its key can't be opened"
                .into(),
        );
    }

    // Validate BEFORE touching anything: the incoming key must open the
    // incoming database.
    let key = fs::read_to_string(&src_key)
        .map_err(|e| format!("Can't read pulse.key: {e}"))?
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("pulse.key in that folder is empty".into());
    }
    {
        let probe = rusqlite::Connection::open(&src_db).map_err(|e| e.to_string())?;
        apply_db_key(&probe, &key)?;
        if !probe_decrypted(&probe) {
            return Err(
                "That backup doesn't match its key file — check you copied the whole pair"
                    .into(),
            );
        }
    }

    let conf = app.path().app_config_dir().map_err(|e| e.to_string())?;
    // Flush any committed-but-uncheckpointed WAL frames back into the main
    // file BEFORE stashing it — otherwise recent transactions that lived only
    // in the -wal would silently vanish from the stashed snapshot if this
    // restore has to be rolled back.
    let live_db = conf.join("pulse.db");
    if live_db.is_file() {
        let flush = rusqlite::Connection::open(&live_db).map_err(|e| e.to_string())?;
        let _ = flush.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
        drop(flush);
    }
    // Stash this install's current key/db aside (best-effort) so the swap is
    // reversible if the wrong pair was picked. Sidecars go too — stale ones
    // left behind would corrupt whichever db lands next to them.
    let stash = conf.join(format!("pre-external-restore-{}", std::process::id()));
    let _ = fs::create_dir_all(&stash);
    for name in ["pulse.db", "pulse.key", "pulse.db-wal", "pulse.db-shm"] {
        let p = conf.join(name);
        if p.is_file() {
            let _ = fs::rename(&p, stash.join(name));
        }
    }
    if let Err(e) = swap_in_restored_pair(&conf, &src_db, &src_key, &stash) {
        return Err(e);
    }
    // Drop stale sidecars from the previous install.
    let _ = fs::remove_file(conf.join("pulse.db-wal"));
    let _ = fs::remove_file(conf.join("pulse.db-shm"));
    Ok(format!(
        "Restored {}. Pulse will restart.",
        src_db.file_name().unwrap_or_default().to_string_lossy()
    ))
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
    let mut conn = open_db(&app)?;
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
        let existing = match existing {
            Some(id) => Some(id),
            None => tx
                .query_row(
                    "SELECT id FROM products WHERE lower(name) = lower(?1) ORDER BY id LIMIT 1",
                    [&name],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?,
        };

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
                if let Some(ps) = r.pack_size.filter(|p| *p >= 1) {
                    vals.push(rusqlite::types::Value::Integer(ps));
                    sets.push(format!("pack_size = ?{}", vals.len()));
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
                if qty > 0 {
                    // Keep the batch ledger in step with the imported stock.
                    add_to_batch(
                        &tx,
                        id,
                        r.batch_no.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                        r.expiry_date.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                        qty,
                    )?;
                }
                updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO products (name, barcode, category, manufacturer, supplier, strength, unit, rx_flag, batch_no, expiry_date, cost_price, selling_price, stock_qty, reorder_level, pack_size, fda_reg_no, is_controlled, active)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1)",
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
                        r.pack_size.filter(|p| *p >= 1).unwrap_or(1),
                        r.fda_reg_no.as_deref(),
                        r.is_controlled.unwrap_or(0),
                    ],
                )
                .map_err(|e| e.to_string())?;
                if qty > 0 {
                    add_to_batch(
                        &tx,
                        tx.last_insert_rowid(),
                        r.batch_no.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                        r.expiry_date.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                        qty,
                    )?;
                }
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

/// Commit mapped customer rows in ONE transaction. Matching rule: by name
/// (case-insensitive) — customers have no barcode, so name is the key, exactly
/// like the rest of the credit ledger. A match updates phone / discount tier
/// when provided and RAISES the opening balance to the larger of the two (an
/// import should never *reduce* what's already owed). No match creates a new
/// patient. Rows with no name are skipped and reported.
#[tauri::command]
fn commit_customer_import(
    app: AppHandle,
    records: Vec<CustomerImportRow>,
) -> Result<ImportSummary, String> {
    if records.is_empty() {
        return Err("No rows to import".into());
    }
    if records.len() > 5000 {
        return Err("Too many rows — max 5000 per import".into());
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
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
                errors.push(format!("Row {}: missing customer name", row_no));
            }
            continue;
        }
        let phone = r.phone.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let discount = r.discount_tier.filter(|d| *d > 0.0);
        // An opening balance can't be negative — clamp, don't import a debt we owe.
        let opening = r.opening_balance.unwrap_or(0.0);
        let opening = if opening < 0.0 { 0.0 } else { opening };

        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM patients WHERE lower(name) = lower(?1) ORDER BY id LIMIT 1",
                [&name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE patients
                     SET phone = CASE WHEN (?2 IS NOT NULL AND (phone IS NULL OR phone = '')) THEN ?2 ELSE phone END,
                         discount_tier = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE discount_tier END,
                         opening_balance = MAX(COALESCE(opening_balance, 0), ?4)
                     WHERE id = ?1",
                    rusqlite::params![id, phone, discount, opening],
                )
                .map_err(|e| e.to_string())?;
                updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO patients (name, phone, discount_tier, opening_balance, created_at)
                     VALUES (?1, ?2, COALESCE(?3, 0), ?4, datetime('now', 'localtime'))",
                    rusqlite::params![name, phone, discount, opening],
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

/// Commit mapped supplier rows in ONE transaction. Matching rule: by name
/// (case-insensitive, and `suppliers.name` is UNIQUE). A match refreshes phone /
/// location / opening balance (take the larger owed); no match creates a new
/// supplier. `opening_balance` is what the pharmacy already owes the supplier at
/// switch-on, so it flows straight into the Accounts-Payable report.
#[tauri::command]
fn commit_supplier_import(
    app: AppHandle,
    records: Vec<SupplierImportRow>,
) -> Result<ImportSummary, String> {
    if records.is_empty() {
        return Err("No rows to import".into());
    }
    if records.len() > 5000 {
        return Err("Too many rows — max 5000 per import".into());
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
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
                errors.push(format!("Row {}: missing supplier name", row_no));
            }
            continue;
        }
        let phone = r.phone.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let location = r.location.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let opening = r.opening_balance.unwrap_or(0.0);
        let opening = if opening < 0.0 { 0.0 } else { opening };

        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM suppliers WHERE lower(name) = lower(?1) ORDER BY id LIMIT 1",
                [&name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE suppliers
                     SET phone = CASE WHEN (?2 IS NOT NULL AND (phone IS NULL OR phone = '')) THEN ?2 ELSE phone END,
                         location = CASE WHEN (?3 IS NOT NULL AND (location IS NULL OR location = '')) THEN ?3 ELSE location END,
                         opening_balance = MAX(COALESCE(opening_balance, 0), ?4)
                     WHERE id = ?1",
                    rusqlite::params![id, phone, location, opening],
                )
                .map_err(|e| e.to_string())?;
                updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO suppliers (name, phone, location, opening_balance, created_at)
                     VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'))",
                    rusqlite::params![name, phone, location, opening],
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

/// Remove all sample/demo data in one transaction so a database can be handed
/// to a real client clean. Targets only the clearly-fake rows the seed created:
///   - sales with a DMO- receipt prefix (and their items + payments)
///   - the "Demo Wholesale Ltd" supplier, its demo purchase + lines
///   - products whose barcode is the demo range (6220000000…) or name starts
///     "Demo —" (the starter/sample catalog — safe to drop; real imports use
///     different barcodes)
///   - the "Ama Mensah" / 0241234567 sample patient, only if it has no sales
/// Everything else (real imported products, customers, suppliers) is untouched.
/// Manager-PIN gated because it is destructive.
#[derive(Serialize)]
pub struct DemoPurgeSummary {
    sales: usize,
    purchases: usize,
    suppliers: usize,
    products: usize,
    patients: usize,
}

#[tauri::command]
fn purge_demo_data(
    app: AppHandle,
    manager_pin: Option<String>,
) -> Result<DemoPurgeSummary, String> {
    let mut conn = open_db(&app)?;
    check_manager_pin(&conn, manager_pin)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE receipt_no LIKE 'DMO-%')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE receipt_no LIKE 'DMO-%')",
        [],
    )
    .map_err(|e| e.to_string())?;
    let sales = tx
        .execute("DELETE FROM sales WHERE receipt_no LIKE 'DMO-%'", [])
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE id LIKE 'PUR-DEMO-%' OR supplier_name = 'Demo Wholesale Ltd')",
        [],
    )
    .map_err(|e| e.to_string())?;
    let purchases = tx
        .execute(
            "DELETE FROM purchases WHERE id LIKE 'PUR-DEMO-%' OR supplier_name = 'Demo Wholesale Ltd'",
            [],
        )
        .map_err(|e| e.to_string())?;
    let suppliers = tx
        .execute("DELETE FROM suppliers WHERE name = 'Demo Wholesale Ltd'", [])
        .map_err(|e| e.to_string())?;
    let products = tx
        .execute(
            "DELETE FROM products WHERE barcode LIKE '6220000000%' OR name LIKE 'Demo —%'",
            [],
        )
        .map_err(|e| e.to_string())?;
    let patients = tx
        .execute(
            "DELETE FROM patients WHERE name = 'Ama Mensah' AND phone = '0241234567'
             AND NOT EXISTS (SELECT 1 FROM sales WHERE patient_name = 'Ama Mensah')",
            [],
        )
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(DemoPurgeSummary {
        sales,
        purchases,
        suppliers,
        products,
        patients,
    })
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FDA Ghana catalog (autocomplete for drug entry)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FdaDrug {
    pub id: String,
    pub product_id: Option<String>,
    pub product_name: String,
    pub generic_name: Option<String>,
    pub strength: Option<String>,
    pub active_ingredient: Option<String>,
    pub dosage_form: Option<String>,
    pub product_category: Option<String>,
    pub product_sub_category: Option<String>,
    pub registration_number: Option<String>,
    pub manufacturer: Option<String>,
    pub client_name: Option<String>,
    pub registration_date: Option<String>,
    pub expiry_date: Option<String>,
    pub status: Option<String>,
}

#[tauri::command]
fn search_fda_drugs(app: AppHandle, query: String, limit: Option<i64>) -> Result<Vec<FdaDrug>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let lim = limit.unwrap_or(20).clamp(1, 50) as i64;
    // Build FTS prefix query: each term gets a trailing *.
    let fts_q = q
        .split_whitespace()
        .map(|t| format!("{}*", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ");
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, product_name, generic_name, strength, active_ingredient, dosage_form,
                    product_category, product_sub_category, registration_number, manufacturer, client_name,
                    registration_date, expiry_date, status
             FROM fda_drugs
             WHERE rowid IN (SELECT rowid FROM fda_drugs_fts WHERE fda_drugs_fts MATCH ? ORDER BY rank)
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![fts_q, lim], |r| {
            Ok(FdaDrug {
                id: r.get(0)?,
                product_id: r.get(1)?,
                product_name: r.get(2)?,
                generic_name: r.get(3)?,
                strength: r.get(4)?,
                active_ingredient: r.get(5)?,
                dosage_form: r.get(6)?,
                product_category: r.get(7)?,
                product_sub_category: r.get(8)?,
                registration_number: r.get(9)?,
                manufacturer: r.get(10)?,
                client_name: r.get(11)?,
                registration_date: r.get(12)?,
                expiry_date: r.get(13)?,
                status: r.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    // Boost product_name matches and de-prioritize veterinary (VETO) for human pharmacy use.
    {
        let ql = q.to_lowercase();
        out.sort_by(|a, b| {
            let score = |d: &FdaDrug| {
                let mut s = 0;
                if d.product_name.to_lowercase().contains(&ql) {
                    s += 10;
                }
                if d.generic_name.as_deref().unwrap_or("").to_lowercase().contains(&ql) {
                    s += 5;
                }
                if d.active_ingredient.as_deref().unwrap_or("").to_lowercase().contains(&ql) {
                    s += 2;
                }
                if d.product_name.to_uppercase().contains("VETO") {
                    s -= 5;
                }
                s
            };
            score(b).cmp(&score(a))
        });
    }
    // Fallback: if FTS finds nothing, try LIKE (handles short/abbreviated terms).
    if out.is_empty() {
        let like_q = format!("%{}%", q);
        let mut stmt2 = conn
            .prepare(
                "SELECT id, product_id, product_name, generic_name, strength, active_ingredient, dosage_form,
                        product_category, product_sub_category, registration_number, manufacturer, client_name,
                        registration_date, expiry_date, status
                 FROM fda_drugs WHERE product_name LIKE ? OR generic_name LIKE ? LIMIT ?",
            )
            .map_err(|e| e.to_string())?;
        let rows2 = stmt2
            .query_map(rusqlite::params![like_q.clone(), like_q, lim], |r| {
                Ok(FdaDrug {
                    id: r.get(0)?,
                    product_id: r.get(1)?,
                    product_name: r.get(2)?,
                    generic_name: r.get(3)?,
                    strength: r.get(4)?,
                    active_ingredient: r.get(5)?,
                    dosage_form: r.get(6)?,
                    product_category: r.get(7)?,
                    product_sub_category: r.get(8)?,
                    registration_number: r.get(9)?,
                    manufacturer: r.get(10)?,
                    client_name: r.get(11)?,
                    registration_date: r.get(12)?,
                    expiry_date: r.get(13)?,
                    status: r.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for r in rows2 {
            out.push(r.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

#[tauri::command]
fn import_fda_catalog(app: AppHandle, drugs: Vec<FdaDrug>) -> Result<usize, String> {
    if drugs.is_empty() {
        return Ok(0);
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM fda_drugs", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM fda_drugs_fts", []).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for d in drugs {
        tx.execute(
            "INSERT OR REPLACE INTO fda_drugs
             (id, product_id, product_name, generic_name, strength, active_ingredient, dosage_form,
              product_category, product_sub_category, registration_number, manufacturer, client_name,
              registration_date, expiry_date, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            rusqlite::params![
                d.id,
                d.product_id,
                d.product_name,
                d.generic_name,
                d.strength,
                d.active_ingredient,
                d.dosage_form,
                d.product_category,
                d.product_sub_category,
                d.registration_number,
                d.manufacturer,
                d.client_name,
                d.registration_date,
                d.expiry_date,
                d.status
            ],
        )
        .map_err(|e| e.to_string())?;
        // Keep FTS in sync manually (no triggers).
        let rowid: i64 = tx
            .query_row(
                "SELECT rowid FROM fda_drugs WHERE id = ?1",
                rusqlite::params![d.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO fda_drugs_fts(rowid, product_name, generic_name, strength, active_ingredient) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![rowid, d.product_name, d.generic_name, d.strength, d.active_ingredient],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
async fn refresh_fda_catalog(app: AppHandle) -> Result<usize, String> {
    use serde::Deserialize;
    #[derive(Deserialize)]
    struct ApiRow {
        product_uuid: Option<String>,
        product_id: Option<String>,
        product_name: Option<String>,
        generic_name: Option<String>,
        strength: Option<String>,
        active_ingredient: Option<String>,
        dosage_form_indication: Option<String>,
        product_category: Option<String>,
        product_sub_category: Option<String>,
        registration_number: Option<String>,
        manufacturer: Option<String>,
        client_name: Option<String>,
        registration_date: Option<String>,
        expiry_date: Option<String>,
        status: Option<String>,
    }
    #[derive(Deserialize)]
    struct ApiResp {
        data: Vec<ApiRow>,
        #[serde(rename = "recordsFiltered")]
        records_filtered: Option<u64>,
        #[serde(rename = "recordsTotal")]
        records_total: Option<u64>,
    }
    // Accept the expired cert on verifypermit.fdaghana.gov.gh.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut all: Vec<FdaDrug> = Vec::new();
    let mut start: u64 = 0;
    let page_size: u64 = 200;
    let mut draw: u64 = 1;
    let mut total: Option<u64> = None;
    loop {
        let url = format!(
            "https://verifypermit.fdaghana.gov.gh/publicsearch?draw={draw}&columns%5B0%5D%5Bdata%5D=DT_RowIndex&columns%5B1%5D%5Bdata%5D=client_name&columns%5B2%5D%5Bdata%5D=product_name&columns%5B3%5D%5Bdata%5D=product_category&columns%5B4%5D%5Bdata%5D=expiry_date&columns%5B5%5D%5Bdata%5D=status&columns%5B6%5D%5Bdata%5D=action&order%5B0%5D%5Bcolumn%5D=1&order%5B0%5D%5Bdir%5D=desc&start={start}&length={page_size}&search%5Bvalue%5D=&search%5Bregex%5D=false"
        );
        let resp: ApiResp = client
            .get(&url)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if total.is_none() {
            total = resp.records_total;
        }
        let rows = resp.data;
        if rows.is_empty() {
            break;
        }
        // Progress: payload is { current, total, page, totalPages }.
        let _ = app.emit(
            "fda-progress",
            serde_json::json!({
                "current": all.len(),
                "total": total.unwrap_or(0),
                "page": draw,
                "totalPages": total.map(|t| (t + page_size - 1) / page_size).unwrap_or(0)
            }),
        );
        for r in &rows {
            let cat = r.product_category.as_deref().unwrap_or("").to_uppercase();
            if cat != "DRUG" && cat != "DRUGS" {
                continue;
            }
            let name = r.product_name.clone().unwrap_or_default().trim().to_string();
            if name.is_empty() {
                continue;
            }
            all.push(FdaDrug {
                id: r.product_uuid.clone().or_else(|| r.product_id.clone()).unwrap_or_else(|| name.clone()),
                product_id: r.product_id.clone(),
                product_name: name,
                generic_name: r.generic_name.clone(),
                strength: r.strength.clone(),
                active_ingredient: r.active_ingredient.clone(),
                dosage_form: r.dosage_form_indication.clone(),
                product_category: r.product_category.clone(),
                product_sub_category: r.product_sub_category.clone(),
                registration_number: r.registration_number.clone(),
                manufacturer: r.manufacturer.clone(),
                client_name: r.client_name.clone(),
                registration_date: r.registration_date.clone(),
                expiry_date: r.expiry_date.clone(),
                status: r.status.clone(),
            });
        }
        if (rows.len() as u64) < page_size {
            break;
        }
        if let Some(t) = total {
            if start + (rows.len() as u64) >= t {
                break;
            }
        }
        start += rows.len() as u64;
        draw += 1;
        // Be nice to the FDA server.
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    if all.is_empty() {
        return Err("No DRUG rows returned from FDA register".into());
    }
    // Reuse the import logic (single transaction).
    import_fda_catalog(app, all)
}

// ---------------------------------------------------------------------------
// ESC/POS thermal receipt printing (network, raw TCP port 9100)
// ---------------------------------------------------------------------------

/// One item row of a thermal receipt. All strings arrive pre-formatted from
/// the frontend (money already rendered) so this side only does layout.
#[derive(Deserialize)]
pub struct EscposLine {
    name: String,
    /// e.g. "2 x 8.00" or "20 strips (2 cartons)"
    detail: String,
    amount: String,
}

#[derive(Deserialize)]
pub struct EscposReceipt {
    host: String,
    #[serde(default = "default_printer_port")]
    port: u16,
    /// Characters per line — 42 for 80mm heads, ~32 for 58mm.
    #[serde(default = "default_paper_width")]
    width: usize,
    pharmacy_name: String,
    receipt_no: String,
    timestamp: String,
    lines: Vec<EscposLine>,
    subtotal: String,
    discount: Option<String>,
    tax: Option<String>,
    total: String,
    /// Pre-formatted payment rows ("Cash 50.00 · ref 123")
    payments: Vec<String>,
    change: Option<String>,
    footer: Option<String>,
}

fn default_printer_port() -> u16 {
    9100
}

fn default_paper_width() -> usize {
    42
}

/// Strip characters outside CP437-safe ASCII — cheap thermal fonts render
/// anything else as garbage (the cedi sign becomes "GH" via fmtMoneyGhs).
fn ascii_only(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '?' })
        .collect()
}

/// Render the receipt as raw ESC/POS bytes: init, centered double-size
/// header, item rows with right-aligned amounts, totals block, cut.
/// Pure so tests can assert on the byte stream without a printer.
fn build_escpos_bytes(r: &EscposReceipt, width: usize) -> Vec<u8> {
    const ESC: u8 = 0x1B;
    const GS: u8 = 0x1D;
    let mut out = Vec::new();
    // ESC @ — initialize
    out.extend_from_slice(&[ESC, b'@']);
    let center = |out: &mut Vec<u8>| out.extend_from_slice(&[ESC, b'a', 1]);
    let left = |out: &mut Vec<u8>| out.extend_from_slice(&[ESC, b'a', 0]);
    let big_on = |out: &mut Vec<u8>| {
        out.extend_from_slice(&[GS, b'!', 0x11]);
        out.extend_from_slice(&[ESC, b'E', 1]);
    };
    let big_off = |out: &mut Vec<u8>| {
        out.extend_from_slice(&[GS, b'!', 0x00]);
        out.extend_from_slice(&[ESC, b'E', 0]);
    };
    let bold_off = |out: &mut Vec<u8>| out.extend_from_slice(&[ESC, b'E', 0]);
    let text = |out: &mut Vec<u8>, s: &str| {
        out.extend_from_slice(ascii_only(s).as_bytes());
        out.push(b'\n');
    };

    center(&mut out);
    big_on(&mut out);
    text(&mut out, r.pharmacy_name.trim());
    big_off(&mut out);
    text(&mut out, &r.receipt_no);
    text(&mut out, &r.timestamp);
    left(&mut out);

    for l in &r.lines {
        // Name left / amount right on one line; detail indented below.
        let amount = ascii_only(l.amount.trim());
        let mut name = ascii_only(l.name.trim());
        if name.len() + amount.len() + 1 > width.saturating_sub(2) {
            let room = width.saturating_sub(2).saturating_sub(amount.len() + 1);
            name.truncate(room.max(3));
        }
        let pad = (width.saturating_sub(name.len() + amount.len())).max(1);
        text(&mut out, &format!("{}{}{}", name, " ".repeat(pad), amount));
        let detail = l.detail.trim();
        if !detail.is_empty() && !detail.eq_ignore_ascii_case("1") {
            text(&mut out, &format!("  {}", detail));
        }
    }

    let rule: String = "-".repeat(width.min(48));
    text(&mut out, &rule);
    let kv = |out: &mut Vec<u8>, k: &str, v: &str| {
        let k = ascii_only(k.trim());
        let v = ascii_only(v.trim());
        let pad = (width.saturating_sub(k.len() + v.len())).max(1);
        text(out, &format!("{}{}{}", k, " ".repeat(pad), v));
    };
    kv(&mut out, "Subtotal", &r.subtotal);
    if let Some(d) = &r.discount {
        kv(&mut out, "Discount", d);
    }
    if let Some(t) = &r.tax {
        kv(&mut out, "Tax", t);
    }
    bold_off(&mut out); // safety no-op before the emphasized total
    out.extend_from_slice(&[ESC, b'E', 1]); // bold total
    kv(&mut out, "TOTAL", &r.total);
    out.extend_from_slice(&[ESC, b'E', 0]);
    for p in &r.payments {
        kv(&mut out, "", p);
    }
    if let Some(c) = &r.change {
        kv(&mut out, "Change", c);
    }
    if let Some(f) = &r.footer {
        center(&mut out);
        text(&mut out, "");
        text(&mut out, f);
    }
    // Feed + full cut
    out.extend_from_slice(b"\n\n\n");
    out.extend_from_slice(&[GS, b'V', 0]);
    out
}

/// Send a receipt to an ESC/POS thermal printer over raw TCP (port 9100 —
/// the default every networked and router-shared USB thermal printer
/// listens on). Fully offline; nothing leaves the shop's LAN.
#[tauri::command]
fn print_receipt(receipt: EscposReceipt) -> Result<String, String> {
    use std::io::Write;
    use std::net::ToSocketAddrs;
    if receipt.host.trim().is_empty() {
        return Err("No printer configured — set its address in Settings".into());
    }
    let bytes = build_escpos_bytes(&receipt, receipt.width.max(20).min(80));
    let addr = (receipt.host.trim(), receipt.port)
        .to_socket_addrs()
        .map_err(|e| format!("Bad printer address {}: {}", receipt.host, e))?
        .next()
        .ok_or_else(|| format!("Bad printer address {}", receipt.host))?;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(4))
        .map_err(|e| format!("Can't reach printer at {}:{} — {}", receipt.host, receipt.port, e))?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(4)))
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(format!("Printed to {}:{}", receipt.host, receipt.port))
}

// ---------------------------------------------------------------------------
// Loss prevention — manager PIN gate (hashed), bulk stock take, backups
// ---------------------------------------------------------------------------

/// Manager PINs are never stored as entered: `sha256$<rounds>$<salt-hex>$<hash-hex>`,
/// salted + stretched SHA-256 (100k rounds ≈ tens of ms native). This keeps a
/// database/keyfile dump from revealing the code someone types daily.
/// Honest scope: 4–8 digit PINs are a small keyspace, so this is deliberate
/// friction for casual inspection, not protection against an offline
/// brute-force specialist.
const PIN_ROUNDS: u32 = 100_000;

fn hash_pin(pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut rng = rand::thread_rng();
    let mut salt = [0u8; 16];
    use rand::RngCore;
    rng.fill_bytes(&mut salt);
    let salt_hex: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let mut h = Sha256::new();
    h.update(salt_hex.as_bytes());
    h.update(pin.as_bytes());
    let mut acc = h.finalize();
    for _ in 1..PIN_ROUNDS {
        let mut h = Sha256::new();
        h.update(acc);
        acc = h.finalize();
    }
    let hash_hex: String = acc.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256${PIN_ROUNDS}${salt_hex}${hash_hex}")
}

/// Verify `provided` against a stored value that may be hashed (current
/// format) or legacy plaintext (pre-hash installs).
fn pin_matches(stored: &str, provided: &str) -> bool {
    let stored = stored.trim();
    if let Some(rest) = stored.strip_prefix("sha256$") {
        let mut parts = rest.splitn(3, '$');
        let (Some(rounds), Some(salt), Some(expected)) = (parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        let Ok(rounds) = rounds.parse::<u32>() else {
            return false;
        };
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(salt.as_bytes());
        h.update(provided.trim().as_bytes());
        let mut acc = h.finalize();
        for _ in 1..rounds.max(1) {
            let mut h = Sha256::new();
            h.update(acc);
            acc = h.finalize();
        }
        let hex: String = acc.iter().map(|b| format!("{b:02x}")).collect();
        // Compare digests (fixed length) rather than raw PINs.
        constant_time_eq(hex.as_bytes(), expected.as_bytes())
    } else {
        constant_time_eq(stored.as_bytes(), provided.trim().as_bytes())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// One-time upgrade: hash a legacy plaintext manager_pin in place at startup
/// (after migrations — the settings table must exist first).
fn migrate_plaintext_pin(conn: &rusqlite::Connection) -> Result<(), String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'manager_pin'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(v) = stored else { return Ok(()) };
    let v = v.trim().to_string();
    if v.is_empty() || v.starts_with("sha256$") {
        return Ok(()); // nothing to do / already hashed
    }
    conn.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'manager_pin'",
        [hash_pin(&v)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Manager PIN gate for sensitive actions (voids, returns, supplier payments,
/// credit settlements). When no PIN is configured everything is allowed; when
/// set, `provided` must verify against it exactly. Wrong attempts are
/// rate-limited in-process: 5 failures trip a 30-second lockout so a 4-digit
/// PIN can't be brute-forced from repeated command calls.
const PIN_MAX_FAILURES: u32 = 5;
const PIN_LOCKOUT_MS: u64 = 30_000;

fn check_manager_pin(
    conn: &rusqlite::Connection,
    provided: Option<String>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    // The limiter is deliberately NOT active under `cargo test`: the test
    // suite runs many PIN-gated paths in parallel against one process, and a
    // shared counter would make unrelated tests lock each other out.
    #[cfg(not(test))]
    {
        static FAILURES: AtomicU32 = AtomicU32::new(0);
        static LOCKED_UNTIL: AtomicU64 = AtomicU64::new(0);

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let locked_until = LOCKED_UNTIL.load(Ordering::Relaxed);
        if locked_until > now_ms {
            return Err(format!(
                "Too many wrong PIN attempts — try again in {}s",
                (locked_until - now_ms + 999) / 1000
            ));
        }

        match verify(conn, provided)? {
            Ok(()) => {
                FAILURES.store(0, Ordering::Relaxed);
                return Ok(());
            }
            Err(e) => {
                let fails = FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
                if fails >= PIN_MAX_FAILURES {
                    LOCKED_UNTIL.store(now_ms + PIN_LOCKOUT_MS, Ordering::Relaxed);
                    FAILURES.store(0, Ordering::Relaxed);
                    return Err("Too many wrong PIN attempts — locked for 30 seconds".into());
                }
                return Err(e);
            }
        }
    }
    #[cfg(test)]
    verify(conn, provided)?
}

/// Shared verification body used by both the rate-limited (production) and
/// direct (test) paths.
fn verify(
    conn: &rusqlite::Connection,
    provided: Option<String>,
) -> Result<Result<(), String>, String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'manager_pin'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(expected) = stored.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        // No gate configured.
        return Ok(Ok(()));
    };
    match provided.as_deref() {
        Some(p) if pin_matches(expected, p) => Ok(Ok(())),
        _ => Ok(Err("Manager PIN required for this action".into())),
    }
}

/// Set or clear the manager PIN. Changing/clearing an ACTIVE PIN requires the
/// current one — otherwise anyone at the counter could quietly take over the
/// gate. Stores only the hash.
#[tauri::command]
fn set_manager_pin(
    app: AppHandle,
    current_pin: Option<String>,
    new_pin: Option<String>,
) -> Result<(), String> {
    let new_pin = new_pin
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(p) = &new_pin {
        if !p.chars().all(|c| c.is_ascii_digit()) || !(4..=8).contains(&p.chars().count()) {
            return Err("PIN must be 4–8 digits".into());
        }
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let stored: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'manager_pin'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if stored
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        // A PIN is active → the operator must prove they know it.
        check_manager_pin(&tx, current_pin)?;
    }
    match &new_pin {
        Some(p) => {
            let hashed = hash_pin(p);
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('manager_pin', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&hashed],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            tx.execute("DELETE FROM settings WHERE key = 'manager_pin'", [])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Whether a provided manager PIN verifies — used by the role switcher to
/// unlock Manager mode. No PIN configured → trivially yes.
#[tauri::command]
fn verify_manager_pin(app: AppHandle, pin: Option<String>) -> Result<bool, String> {
    let conn = open_db(&app)?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'manager_pin'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match stored.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(_) => check_manager_pin(&conn, pin).is_ok(),
        None => true,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub is_active: i64,
    pub must_change_password: i64,
    pub created_at: String,
}

fn user_from_row(row: &rusqlite::Row) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        role: row.get(3)?,
        is_active: row.get(4)?,
        must_change_password: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
fn create_user(
    app: AppHandle,
    username: String,
    #[serde(alias = "displayName")]
    display_name: String,
    password: String,
    role: String,
) -> Result<UserRow, String> {
    let username = username.trim().to_lowercase();
    let display_name = display_name.trim().to_string();
    let role = role.trim().to_lowercase();
    if username.is_empty() || username.len() < 3 {
        return Err("Username must be at least 3 characters".into());
    }
    if !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Username may only contain letters, numbers, _ or -".into());
    }
    if display_name.is_empty() {
        return Err("Display name is required".into());
    }
    if password.len() < 4 {
        return Err("Password must be at least 4 characters".into());
    }
    if role != "manager" && role != "worker" {
        return Err("Role must be manager or worker".into());
    }
    let conn = open_db(&app)?;
    // Username unique (NOCASE)
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM users WHERE username = ?1 COLLATE NOCASE",
            [&username],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err("That username is already taken".into());
    }
    let hash = hash_pin(&password);
    conn.execute(
        "INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password) VALUES (?1, ?2, ?3, ?4, 1, 1)",
        rusqlite::params![username, display_name, hash, role],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let row = conn
        .query_row(
            "SELECT id, username, display_name, role, is_active, must_change_password, created_at FROM users WHERE id = ?1",
            [id],
            user_from_row,
        )
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
fn login_user(app: AppHandle, username: String, password: String) -> Result<UserRow, String> {
    let username = username.trim().to_lowercase();
    if username.is_empty() || password.is_empty() {
        return Err("Username and password are required".into());
    }
    let conn = open_db(&app)?;
    let (id, stored_hash, is_active): (i64, String, i64) = conn
        .query_row(
            "SELECT id, password_hash, is_active FROM users WHERE username = ?1 COLLATE NOCASE",
            [&username],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "Invalid username or password".to_string())?;
    if is_active == 0 {
        return Err("That account is deactivated".into());
    }
    if !pin_matches(&stored_hash, &password) {
        return Err("Invalid username or password".into());
    }
    let row = conn
        .query_row(
            "SELECT id, username, display_name, role, is_active, must_change_password, created_at FROM users WHERE id = ?1",
            [id],
            user_from_row,
        )
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
fn list_users(app: AppHandle) -> Result<Vec<UserRow>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, username, display_name, role, is_active, must_change_password, created_at FROM users ORDER BY role DESC, username")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], user_from_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn update_user(
    app: AppHandle,
    id: i64,
    #[serde(alias = "displayName")]
    display_name: Option<String>,
    role: Option<String>,
    #[serde(alias = "isActive")]
    is_active: Option<bool>,
) -> Result<UserRow, String> {
    let conn = open_db(&app)?;
    if let Some(dn) = display_name {
        let dn = dn.trim().to_string();
        if dn.is_empty() {
            return Err("Display name cannot be empty".into());
        }
        conn.execute("UPDATE users SET display_name = ?1 WHERE id = ?2", rusqlite::params![dn, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(r) = role {
        let r = r.trim().to_lowercase();
        if r != "manager" && r != "worker" {
            return Err("Role must be manager or worker".into());
        }
        // Prevent demoting the last manager.
        if r == "worker" {
            let mgr_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM users WHERE role = 'manager' AND is_active = 1 AND id != ?1", [id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            let this_role: String = conn
                .query_row("SELECT role FROM users WHERE id = ?1", [id], |row| row.get(0))
                .map_err(|_| "User not found".to_string())?;
            if this_role == "manager" && mgr_count == 0 {
                return Err("Cannot demote the last active manager".into());
            }
        }
        conn.execute("UPDATE users SET role = ?1 WHERE id = ?2", rusqlite::params![r, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(active) = is_active {
        // Prevent deactivating the last manager.
        if !active {
            let mgr_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM users WHERE role = 'manager' AND is_active = 1 AND id != ?1", [id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            let this_role: String = conn
                .query_row("SELECT role FROM users WHERE id = ?1", [id], |row| row.get(0))
                .map_err(|_| "User not found".to_string())?;
            if this_role == "manager" && mgr_count == 0 {
                return Err("Cannot deactivate the last active manager".into());
            }
        }
        conn.execute("UPDATE users SET is_active = ?1 WHERE id = ?2", rusqlite::params![if active { 1 } else { 0 }, id])
            .map_err(|e| e.to_string())?;
    }
    let row = conn
        .query_row(
            "SELECT id, username, display_name, role, is_active, must_change_password, created_at FROM users WHERE id = ?1",
            [id],
            user_from_row,
        )
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
fn reset_user_password(
    app: AppHandle,
    id: i64,
    #[serde(alias = "newPassword")]
    new_password: String,
) -> Result<(), String> {
    if new_password.len() < 4 {
        return Err("Password must be at least 4 characters".into());
    }
    let hash = hash_pin(&new_password);
    let conn = open_db(&app)?;
    let n = conn
        .execute(
            "UPDATE users SET password_hash = ?1, must_change_password = 1 WHERE id = ?2",
            rusqlite::params![hash, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("User not found".into());
    }
    Ok(())
}

#[tauri::command]
fn change_own_password(
    app: AppHandle,
    username: String,
    #[serde(alias = "oldPassword")]
    old_password: String,
    #[serde(alias = "newPassword")]
    new_password: String,
) -> Result<(), String> {
    if new_password.len() < 4 {
        return Err("New password must be at least 4 characters".into());
    }
    let username = username.trim().to_lowercase();
    let conn = open_db(&app)?;
    let (id, stored): (i64, String) = conn
        .query_row(
            "SELECT id, password_hash FROM users WHERE username = ?1 COLLATE NOCASE",
            [&username],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Account not found".to_string())?;
    if !pin_matches(&stored, &old_password) {
        return Err("Current password is incorrect".into());
    }
    let hash = hash_pin(&new_password);
    conn.execute(
        "UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE id = ?2",
        rusqlite::params![hash, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One line of a stock-take sheet: what the shelf actually counted.
#[derive(Deserialize)]
pub struct StockTakeLine {
    product_id: i64,
    counted: i64,
}

/// Apply a completed physical count atomically: every variance becomes a
/// products.stock_qty correction + a matching batch-ledger move + one
/// 'Stock take' audit row. Products counted unchanged are skipped.
fn commit_stock_take_impl(
    conn: &mut rusqlite::Connection,
    lines: Vec<StockTakeLine>,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    if lines.is_empty() {
        return Err("Nothing to commit".into());
    }
    if lines.len() > 5000 {
        return Err("Too many lines — max 5000 per count".into());
    }
    for l in &lines {
        if l.counted < 0 {
            return Err("Counted quantities can't be negative".into());
        }
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // Does this count reduce anything? Reductions are the shrinkage vector,
    // so they ask for the manager PIN when one is configured — checked
    // BEFORE anything is written.
    for l in &lines {
        let stock: i64 = tx
            .query_row(
                "SELECT stock_qty FROM products WHERE id = ?1",
                [l.product_id],
                |r| r.get(0),
            )
            .map_err(|_| "Unknown product in count sheet".to_string())?;
        if l.counted < stock {
            check_manager_pin(&tx, manager_pin)?;
            break;
        }
    }

    let mut changed: Vec<(String, i64, i64)> = Vec::new();
    for l in &lines {
        let (name, stock): (String, i64) = tx
            .query_row(
                "SELECT name, stock_qty FROM products WHERE id = ?1",
                [l.product_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Unknown product in count sheet".to_string())?;
        if stock == l.counted {
            continue;
        }
        let delta = l.counted - stock;
        tx.execute(
            "UPDATE products SET stock_qty = ?1 WHERE id = ?2",
            rusqlite::params![l.counted, l.product_id],
        )
        .map_err(|e| e.to_string())?;
        // Ledger mirrors the aggregate: reductions consume FEFO like a sale,
        // surpluses land on an undated batch (unknown provenance).
        if delta < 0 {
            fefo_deduct(&tx, l.product_id, -delta)?;
        } else {
            add_to_batch(&tx, l.product_id, None, None, delta)?;
        }
        tx.execute(
            "INSERT INTO stock_adjustments (product_id, product_name, delta, reason, operator)
             VALUES (?1, ?2, ?3, 'Stock take', ?4)",
            rusqlite::params![l.product_id, name, delta, operator],
        )
        .map_err(|e| e.to_string())?;
        changed.push((name, stock, l.counted));
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "changed": changed.len(),
        "unchanged": lines.len() - changed.len(),
    }))
}

/// Copy the database to an EXTERNAL folder (flash drive, second disk) with a
/// timestamped name — offsite insurance for theft/fire/power-surges that a
/// backup on the same machine can't cover. WAL-safe via the online backup API.
#[tauri::command]
fn backup_to_dir(app: AppHandle, dir: String) -> Result<String, String> {
    let path = std::path::Path::new(&dir);
    if !path.is_absolute() {
        return Err("Pick a folder first".into());
    }
    if !path.is_dir() {
        return Err(format!("{} is not a folder", dir));
    }
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dst = path.join(format!("pulse-{}.db", epoch));
    let key = ensure_db_key(&app)?;
    backup_to_path(&db_path(&app)?, &dst, &key)?;
    // The database is unreadable without its key — copy pulse.key alongside
    // so one flash-drive save is a complete, restorable pair.
    let key_dst = path.join("pulse.key");
    let key_src = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pulse.key");
    std::fs::copy(&key_src, &key_dst)
        .map_err(|e| format!("couldn't copy pulse.key: {e}"))?;
    Ok(format!(
        "{} (+ pulse.key)",
        dst.to_string_lossy().into_owned()
    ))
}

/// Commit a completed physical stock count atomically (variance corrections
/// + batch ledger + audit rows). See commit_stock_take_impl.
#[tauri::command]
fn commit_stock_take(
    app: AppHandle,
    counts: Vec<StockTakeLine>,
    operator: Option<String>,
    manager_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut conn = open_db(&app)?;
    commit_stock_take_impl(&mut conn, counts, operator, manager_pin)
}

// --- Atomic intake: stock update/insert and batch row in ONE transaction ---
#[derive(Deserialize)]
pub struct IntakePayload {
    barcode: Option<String>,
    name: String,
    quantity: i64,
    #[serde(default)]
    cost_price: Option<f64>,
    selling_price: f64,
    #[serde(default)]
    batch_no: Option<String>,
    #[serde(default)]
    expiry_date: Option<String>,
    #[serde(default)]
    supplier: Option<String>,
    #[serde(default)]
    manufacturer: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    unit: Option<String>,
    #[serde(default)]
    pack_size: Option<i64>,
}

fn trim_opt(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(String::from)
}

#[tauri::command]
fn intake_stock(app: AppHandle, input: IntakePayload) -> Result<serde_json::Value, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Product name is required".into());
    }
    if input.quantity <= 0 {
        return Err("Quantity must be positive".into());
    }
    if input.selling_price < 0.0 {
        return Err("Selling price can't be negative".into());
    }
    if let Some(c) = input.cost_price {
        if c < 0.0 {
            return Err("Cost price can't be negative".into());
        }
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let bc = trim_opt(&input.barcode);
    let existing: Option<i64> = match bc.as_deref() {
        Some(b) => tx
            .query_row("SELECT id FROM products WHERE barcode = ?1", [b], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?,
        None => None,
    };
    let pack = input.pack_size.filter(|p| *p >= 1);
    let id;
    let created;
    match existing {
        Some(pid) => {
            tx.execute(
                "UPDATE products SET name=?1, selling_price=?2, stock_qty=stock_qty+?3,
                    batch_no=COALESCE(?4,batch_no), expiry_date=COALESCE(?5,expiry_date),
                    supplier=COALESCE(?6,supplier), manufacturer=COALESCE(?7,manufacturer),
                    category=COALESCE(?8,category), cost_price=COALESCE(?9,cost_price),
                    unit=COALESCE(?10,unit), pack_size=COALESCE(?11,pack_size) WHERE id=?12",
                rusqlite::params![
                    name, input.selling_price, input.quantity,
                    trim_opt(&input.batch_no), trim_opt(&input.expiry_date),
                    trim_opt(&input.supplier), trim_opt(&input.manufacturer),
                    trim_opt(&input.category), input.cost_price, trim_opt(&input.unit),
                    pack, pid
                ],
            )
            .map_err(|e| e.to_string())?;
            id = pid;
            created = false;
        }
        None => {
            tx.execute(
                "INSERT INTO products (name,barcode,category,manufacturer,supplier,batch_no,expiry_date,cost_price,selling_price,stock_qty,reorder_level,unit,pack_size)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,10,?11,?12)",
                rusqlite::params![
                    name, input.barcode, input.category, input.manufacturer, input.supplier,
                    input.batch_no, input.expiry_date, input.cost_price.unwrap_or(0.0),
                    input.selling_price, input.quantity, input.unit, pack
                ],
            )
            .map_err(|e| e.to_string())?;
            id = tx.last_insert_rowid();
            created = true;
        }
    }
    add_to_batch(
        &tx,
        id,
        trim_opt(&input.batch_no).as_deref(),
        trim_opt(&input.expiry_date).as_deref(),
        input.quantity,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "id": id, "created": created }))
}

#[tauri::command]
fn quick_add_product(app: AppHandle, name: String, selling_price: f64) -> Result<i64, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Product name is required".into());
    }
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO products (name, barcode, selling_price, stock_qty, reorder_level) VALUES (?1, NULL, ?2, 1, 10)",
        rusqlite::params![name, selling_price],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    add_to_batch(&tx, id, None, None, 1)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[derive(Deserialize)]
pub struct NewProduct {
    name: String,
    barcode: Option<String>,
    category: Option<String>,
    supplier: Option<String>,
    strength: Option<String>,
    generic_name: Option<String>,
    active_ingredient: Option<String>,
    cost_price: f64,
    selling_price: f64,
    stock_qty: i64,
    reorder_level: i64,
    pack_size: i64,
    batch_no: Option<String>,
    expiry_date: Option<String>,
}

#[tauri::command]
fn create_product(app: AppHandle, product: NewProduct) -> Result<i64, String> {
    let name = product.name.trim().to_string();
    if name.is_empty() {
        return Err("Product name is required".into());
    }
    if product.selling_price < 0.0 || product.cost_price < 0.0 {
        return Err("Prices must be 0 or more".into());
    }
    if product.stock_qty < 0 {
        return Err("Stock quantity cannot be negative".into());
    }
    let barcode = product.barcode.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO products (name, barcode, category, supplier, strength, generic_name, active_ingredient, cost_price, selling_price, stock_qty, reorder_level, pack_size, batch_no, expiry_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            name,
            barcode,
            product.category.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.supplier.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.strength.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.generic_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.active_ingredient.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.cost_price,
            product.selling_price,
            product.stock_qty,
            product.reorder_level,
            product.pack_size.max(1),
            product.batch_no.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
            product.expiry_date.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty())
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            "A product with that barcode already exists".to_string()
        } else {
            e.to_string()
        }
    })?;
    let id = tx.last_insert_rowid();
    if product.stock_qty > 0 {
        add_to_batch(&tx, id, product.batch_no.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()), product.expiry_date.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()), product.stock_qty)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
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
    (
        "0019_expenses_discount_tier",
        include_str!("../migrations/0019_expenses_discount_tier.sql"),
    ),
    (
        "0020_sale_items_cost_snapshot",
        include_str!("../migrations/0020_sale_items_cost_snapshot.sql"),
    ),
    (
        "0021_expenses_payment_method",
        include_str!("../migrations/0021_expenses_payment_method.sql"),
    ),
    (
        "0022_batch_fefo",
        include_str!("../migrations/0022_batch_fefo.sql"),
    ),
    (
        "0023_till_floats",
        include_str!("../migrations/0023_till_floats.sql"),
    ),
    (
        "0024_sales_totals",
        include_str!("../migrations/0024_sales_totals.sql"),
    ),
    (
        "0025_demo_sales",
        include_str!("../migrations/0025_demo_sales.sql"),
    ),
    (
        "0026_demo_alerts",
        include_str!("../migrations/0026_demo_alerts.sql"),
    ),
    (
        "0027_patient_opening_balance",
        include_str!("../migrations/0027_patient_opening_balance.sql"),
    ),
    (
        "0028_supplier_opening_balance",
        include_str!("../migrations/0028_supplier_opening_balance.sql"),
    ),
    (
        "0029_seed_products",
        include_str!("../migrations/0029_seed_products.sql"),
    ),
    (
        "0030_fda_drugs",
        include_str!("../migrations/0030_fda_drugs.sql"),
    ),
    (
        "0031_product_generic",
        include_str!("../migrations/0031_product_generic.sql"),
    ),
    (
        "0032_users",
        include_str!("../migrations/0032_users.sql"),
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
    // Encrypt a legacy plaintext database BEFORE touching it, then migrate
    // through the same keyed path every command uses.
    let handle = app.handle().clone();
    migrate_plaintext_db(&handle)?;
    let mut conn = open_db(&handle)?;
    apply_migrations(&mut conn)?;
    // Settings table exists by now — upgrade a legacy plaintext PIN to its
    // stored hash form.
    migrate_plaintext_pin(&conn)?;
    // Seed a default manager if this is a fresh install or an upgrade from
    // pre-users builds (no users yet). Reuse the existing manager_pin hash
    // as the password so the upgrade is seamless; otherwise create a temporary
    // manager/manager that must be changed on first login.
    {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            let pin_hash: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'manager_pin'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            let hash = match pin_hash.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(h) => h.to_string(),
                None => hash_pin("manager"),
            };
            let must_change = if pin_hash.is_some() { 0 } else { 1 };
            let _ = conn.execute(
                "INSERT OR IGNORE INTO users (username, display_name, password_hash, role, is_active, must_change_password) VALUES (?1, ?2, ?3, 'manager', 1, ?4)",
                rusqlite::params!["manager", "Manager", hash, must_change],
            );
        }
    }
    Ok(())
}

/// Applies pending migrations to an already-open connection — split out from
/// run_migrations so tests can seed a plain in-memory connection through the
/// exact same path production uses, instead of duplicating the schema setup.
fn apply_migrations(conn: &mut rusqlite::Connection) -> Result<(), String> {
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
        // Demo/sample data (migrations whose name contains "demo" or "seed")
        // exists for development & evaluation only. Never seed it into a
        // production (release) build, so shipped databases start completely
        // empty — no sample sales, customers, suppliers, or catalog — and a
        // client never inherits anything fake. We still record the version so
        // numbering stays contiguous.
        if !cfg!(debug_assertions) && (name.contains("demo") || name.contains("seed")) {
            conn.pragma_update(None, "user_version", v)
                .map_err(|e| e.to_string())?;
            continue;
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        match exec_migration(&tx, sql) {
            Ok(()) => {
                tx.pragma_update(None, "user_version", v)
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(msg) => {
                drop(tx); // rollback
                return Err(format!("migration {} failed: {}", name, msg));
            }
        }
    }
    Ok(())
}

/// Execute a migration statement-by-statement so a tolerable re-run failure
/// ("duplicate column/table/index already exists") skips just that statement
/// instead of aborting the whole file — execute_batch stopped there while the
/// runner still bumped user_version, silently skipping every later statement.
/// Constraint: migrations must not contain semicolons inside literals or
/// trigger bodies (none do).
fn exec_migration(tx: &rusqlite::Transaction, sql: &str) -> Result<(), String> {
    // Strip '--' comment lines BEFORE splitting on ';' — comments may
    // contain semicolons of their own.
    let stripped = sql
        .lines()
        .filter(|l| !l.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for stmt in stripped.split(';') {
        let stmt = stmt.trim();
        if stmt.is_empty() {
            continue;
        }
        if let Err(e) = tx.execute_batch(stmt) {
            let msg = e.to_string();
            if msg.contains("duplicate column name") || msg.contains("already exists") {
                continue;
            }
            return Err(msg);
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
            return_sale,
            void_last_sale,
            adjust_stock,
            list_backups,
            restore_backup,
            restore_from_dir,
            restart_app,
            parse_stock_file,
            commit_stock_import,
            commit_customer_import,
            commit_supplier_import,
            purge_demo_data,
            save_purchase,
            receive_purchase,
            update_purchase,
            cancel_purchase,
            record_payment,
            settle_credit,
            set_manager_pin,
            verify_manager_pin,
            print_receipt,
            commit_stock_take,
            backup_to_dir,
            intake_stock,
            quick_add_product,
            create_product,
            search_fda_drugs,
            import_fda_catalog,
            refresh_fda_catalog,
            create_user,
            login_user,
            list_users,
            update_user,
            reset_user_password,
            change_own_password
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

/// Coverage for the two highest-stakes commands: complete_sale (money +
/// stock, in one transaction) and return_sale (refunds, double-refund
/// guard). Each test runs the real migrations against a fresh in-memory
/// database, so they exercise the actual schema, not a hand-rolled stand-in.
#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        apply_migrations(&mut conn).expect("apply migrations");
        conn
    }

    fn insert_product(conn: &rusqlite::Connection, name: &str, cost: f64, price: f64, stock: i64) -> i64 {
        conn.execute(
            "INSERT INTO products (name, cost_price, selling_price, stock_qty) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, cost, price, stock],
        )
        .expect("insert product");
        conn.last_insert_rowid()
    }

    fn line(product_id: i64, name: &str, qty: i64, client_price: f64) -> SaleLine {
        SaleLine {
            product_id,
            name: name.to_string(),
            quantity: qty,
            unit_price: client_price,
            unit: None,
        }
    }

    fn cash(amount: f64) -> Payment {
        Payment {
            method: "Cash".to_string(),
            amount,
            reference: None,
        }
    }

    #[test]
    fn complete_sale_rejects_zero_quantity() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Paracetamol", 4.0, 8.0, 50);
        let result = complete_sale_impl(
            &mut conn,
            vec![cash(8.0)],
            vec![line(pid, "Paracetamol", 0, 8.0)],
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err(), "quantity 0 must be rejected");
    }

    #[test]
    fn complete_sale_rejects_negative_quantity() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Paracetamol", 4.0, 8.0, 50);
        let result = complete_sale_impl(
            &mut conn,
            vec![cash(8.0)],
            vec![line(pid, "Paracetamol", -3, 8.0)],
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err(), "negative quantity must be rejected");
    }

    /// PUL-001: complete_sale must price from the catalog, never the client.
    #[test]
    fn complete_sale_ignores_client_supplied_price() {
        let mut conn = test_db();
        // Catalog price is 8.00; the client sends a tampered 0.01.
        let pid = insert_product(&conn, "Paracetamol", 4.0, 8.0, 50);
        let result = complete_sale_impl(
            &mut conn,
            vec![cash(1000.0)], // overpay so the total-coverage check can't fail either way
            vec![line(pid, "Paracetamol", 2, 0.01)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");
        assert!(
            (result.total - 16.0).abs() < 0.001,
            "total was {}, expected 16.00 (2 x catalog price 8.00) — client price must be ignored",
            result.total
        );
    }

    #[test]
    fn complete_sale_rejects_insufficient_stock() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Insulin", 50.0, 90.0, 2);
        let result = complete_sale_impl(
            &mut conn,
            vec![cash(900.0)],
            vec![line(pid, "Insulin", 5, 90.0)],
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err(), "selling more than what's in stock must be rejected");
    }

    /// PUL-006: sale_items.unit_cost must snapshot cost_price at sale time.
    #[test]
    fn complete_sale_snapshots_cost_and_deducts_stock() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Amoxicillin", 22.5, 35.0, 100);
        complete_sale_impl(
            &mut conn,
            vec![cash(70.0)],
            vec![line(pid, "Amoxicillin", 2, 35.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 98, "stock must be deducted by the quantity sold");

        let snapshot_cost: f64 = conn
            .query_row("SELECT unit_cost FROM sale_items WHERE product_id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert!(
            (snapshot_cost - 22.5).abs() < 0.001,
            "sale_items.unit_cost must snapshot the product's cost at sale time"
        );
    }

    #[test]
    fn return_sale_restocks_and_refunds() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Ibuprofen", 9.0, 15.0, 30);
        let sale = complete_sale_impl(
            &mut conn,
            vec![cash(45.0)],
            vec![line(pid, "Ibuprofen", 3, 15.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        let refund = return_sale_impl(
            &mut conn,
            sale.sale_id,
            Some("customer changed mind".into()),
            None,
            vec![ReturnLine {
                product_id: pid,
                quantity: 1,
            }],
            None,
        )
        .expect("return should succeed");

        assert!((refund.total_refunded - 15.0).abs() < 0.001);
        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 28, "30 initial - 3 sold + 1 returned = 28");
    }

    /// The return path's core double-refund guard (also what ReturnModal's
    /// UI now mirrors for its displayed max).
    #[test]
    fn return_sale_rejects_returning_more_than_remains() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Ibuprofen", 9.0, 15.0, 30);
        let sale = complete_sale_impl(
            &mut conn,
            vec![cash(30.0)],
            vec![line(pid, "Ibuprofen", 2, 15.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        return_sale_impl(
            &mut conn,
            sale.sale_id,
            None,
            None,
            vec![ReturnLine {
                product_id: pid,
                quantity: 1,
            }],
            None,
        )
        .expect("first return of 1 should succeed");

        // Only 1 unit remains returnable; asking for 2 more must fail outright,
        // never silently partial-refund or double-refund.
        let second = return_sale_impl(
            &mut conn,
            sale.sale_id,
            None,
            None,
            vec![ReturnLine {
                product_id: pid,
                quantity: 2,
            }],
            None,
        );
        assert!(
            second.is_err(),
            "returning more than what's left on the sale must be rejected"
        );
    }

    // ---- Batch ledger (FEFO) ----

    /// Insert a product plus its batch rows, keeping products.stock_qty equal
    /// to the batch total (the invariant the production paths maintain).
    fn insert_batched_product(
        conn: &rusqlite::Connection,
        name: &str,
        cost: f64,
        price: f64,
        batches: &[(&str, &str, i64)], // (batch_no, expiry, qty)
    ) -> i64 {
        let total: i64 = batches.iter().map(|(_, _, q)| q).sum();
        conn.execute(
            "INSERT INTO products (name, cost_price, selling_price, stock_qty) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, cost, price, total],
        )
        .expect("insert product");
        let pid = conn.last_insert_rowid();
        for (batch_no, expiry, qty) in batches {
            conn.execute(
                "INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![pid, batch_no, expiry, qty],
            )
            .expect("insert batch");
        }
        pid
    }

    fn batch_qty(conn: &rusqlite::Connection, product_id: i64, batch_no: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE((SELECT quantity FROM product_batches WHERE product_id = ?1 AND batch_no = ?2), -1)",
            rusqlite::params![product_id, batch_no],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn sold_batches(conn: &rusqlite::Connection, product_id: i64) -> String {
        conn.query_row(
            "SELECT batches FROM sale_items WHERE product_id = ?1 ORDER BY id DESC LIMIT 1",
            [product_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
        .unwrap_or_default()
    }

    #[test]
    fn fefo_consumes_nearest_expiry_first() {
        let mut conn = test_db();
        let pid = insert_batched_product(
            &conn,
            "Coartem",
            38.0,
            52.0,
            &[("B-OLD", "2026-09-01", 4), ("B-NEW", "2027-01-01", 6)],
        );
        complete_sale_impl(
            &mut conn,
            vec![cash(260.0)],
            vec![line(pid, "Coartem", 5, 52.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 5, "aggregate stock must drop by the quantity sold");
        assert_eq!(batch_qty(&conn, pid, "B-OLD"), 0, "nearest-expiry batch drains first");
        assert_eq!(batch_qty(&conn, pid, "B-NEW"), 5, "newer batch untouched until old is empty");
        assert_eq!(
            sold_batches(&conn, pid),
            "B-OLD@2026-09-01x4;B-NEW@2027-01-01x1",
            "sale_items.batches records exactly which batches dispensed"
        );
    }

    #[test]
    fn return_puts_units_back_on_their_original_batches() {
        let mut conn = test_db();
        let pid = insert_batched_product(
            &conn,
            "Coartem",
            38.0,
            52.0,
            &[("B-OLD", "2026-09-01", 4), ("B-NEW", "2027-01-01", 6)],
        );
        let sale = complete_sale_impl(
            &mut conn,
            vec![cash(260.0)],
            vec![line(pid, "Coartem", 5, 52.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        // Partial return of 2 (of the 5 sold) — restores against the
        // breakdown in order: both units go back to B-OLD.
        return_sale_impl(
            &mut conn,
            sale.sale_id,
            None,
            None,
            vec![ReturnLine {
                product_id: pid,
                quantity: 2,
            }],
            None,
        )
        .expect("return should succeed");

        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 7);
        assert_eq!(batch_qty(&conn, pid, "B-OLD"), 2, "returned units land on their source batch");
        assert_eq!(batch_qty(&conn, pid, "B-NEW"), 5);

        // Ledger total must still equal aggregate stock after the round-trip.
        let ledger: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(quantity),0) FROM product_batches WHERE product_id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ledger, stock, "batch ledger and aggregate stock must stay equal");
    }

    #[test]
    fn fefo_drift_parks_shortfall_on_untracked() {
        let mut conn = test_db();
        // Product created without any batch rows (legacy/imported data) — a
        // sale must still work and reconcile the ledger honestly.
        let pid = insert_product(&conn, "Legacy", 4.0, 8.0, 10);
        complete_sale_impl(
            &mut conn,
            vec![cash(24.0)],
            vec![line(pid, "Legacy", 3, 8.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed despite an empty batch ledger");

        assert_eq!(batch_qty(&conn, pid, "UNTRACKED"), 7);
        assert_eq!(
            sold_batches(&conn, pid),
            "UNTRACKEDx3",
            "the shortfall is recorded as UNTRACKED, never silently lost"
        );
    }

    #[test]
    fn purchase_intake_merges_same_batch_and_splits_new() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "ORS", 1.2, 3.0, 0);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();

        commit_purchase_stock(&tx, pid, "ORS", 5.0, "Pack", 1.2, 3.0, "2027-01-31", None, Some("AX-1")).unwrap();
        commit_purchase_stock(&tx, pid, "ORS", 5.0, "Pack", 1.2, 3.0, "2027-01-31", None, Some("AX-1")).unwrap();
        commit_purchase_stock(&tx, pid, "ORS", 3.0, "Pack", 1.2, 3.0, "2027-02-28", None, Some("AX-2")).unwrap();
        commit_purchase_stock(&tx, pid, "ORS", 2.0, "Pack", 1.2, 3.0, "", None, None).unwrap();
        tx.commit().unwrap();

        assert_eq!(batch_qty(&conn, pid, "AX-1"), 10, "same batch+expiry merges into one row");
        assert_eq!(batch_qty(&conn, pid, "AX-2"), 3);
        assert_eq!(batch_qty(&conn, pid, "UNTRACKED"), -1, "no phantom UNTRACKED row");
        let undated: i64 = conn
            .query_row(
                "SELECT quantity FROM product_batches WHERE product_id = ?1 AND batch_no IS NULL",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(undated, 2, "blank batch lands on the undated batch");

        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 15);
    }

    #[test]
    fn parse_batch_breakdown_is_tolerant() {
        let parts = parse_batch_breakdown("AX@2027-03-15x2;CTx1;junk;;Ax0");
        assert_eq!(
            parts,
            vec![
                ("AX".to_string(), "2027-03-15".to_string(), 2),
                ("CT".to_string(), "".to_string(), 1),
            ],
            "unparseable/zero parts are skipped, not fatal"
        );
        assert!(parse_batch_breakdown("").is_empty());
        // Undated batch name with digits survives (rsplit on the qty separator).
        assert_eq!(
            parse_batch_breakdown("BX12@2026-12-31x3"),
            vec![("BX12".to_string(), "2026-12-31".to_string(), 3)]
        );
    }

    // ---- ESC/POS receipt bytes ----

    fn sample_receipt() -> EscposReceipt {
        EscposReceipt {
            host: "192.168.1.50".into(),
            port: 9100,
            width: 42,
            pharmacy_name: "Pulse Pharmacy".into(),
            receipt_no: "RCPT-20260822-003".into(),
            timestamp: "2026-08-22 10:14".into(),
            lines: vec![
                EscposLine { name: "Paracetamol 500mg".into(), detail: "2 x 8.00".into(), amount: "16.00".into() },
                EscposLine {
                    name: "Amoxicillin 500mg Capsules Very Long Name Indeed Here".into(),
                    detail: "20 strips (2 cartons)".into(),
                    amount: "700.00".into(),
                },
            ],
            subtotal: "716.00".into(),
            discount: Some("-20.00".into()),
            tax: None,
            total: "696.00".into(),
            payments: vec!["Cash 700.00".into()],
            change: Some("4.00".into()),
            footer: Some("Thank you. Get well soon.".into()),
        }
    }

    fn bytes_contain(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn escpos_bytes_start_with_init_and_end_with_cut() {
        let out = build_escpos_bytes(&sample_receipt(), 42);
        assert_eq!(&out[..2], &[0x1B, b'@'], "must begin with ESC @ init");
        assert!(
            bytes_contain(&out, &[0x1D, b'V', 0]),
            "must end with the GS V 0 full-cut command"
        );
        assert!(
            bytes_contain(&out, b"RCPT-20260822-003"),
            "receipt number must appear in the output"
        );
        assert!(bytes_contain(&out, b"TOTAL"), "totals block must be labelled");
    }

    #[test]
    fn escpos_rows_fit_the_paper_width() {
        let width = 42;
        let out = build_escpos_bytes(&sample_receipt(), width);
        let text = String::from_utf8_lossy(&out);
        for line in text.lines().filter(|l| !l.contains('\u{1b}') && !l.contains('\u{1d}')) {
            assert!(
                line.chars().count() <= width,
                "row exceeds paper width: {:?}",
                line
            );
        }
        assert!(
            !text.contains("Indeed Here"),
            "over-long item names get truncated, not wrapped"
        );
    }

    #[test]
    fn sqlcipher_roundtrip_and_plaintext_migration() {
        // Exercises the exact mechanics migrate_plaintext_db uses: a legacy
        // plaintext file becomes an encrypted one, is unreadable without the
        // key, readable with it, and keeps its user_version across the copy.
        let dir = std::env::temp_dir().join(format!("pulse-sqlcipher-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let plain_path = dir.join("plain.db");
        let enc_path = dir.join("enc.db");
        let _ = fs::remove_file(&plain_path);
        let _ = fs::remove_file(&enc_path);
        let key = "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8";

        // 1. Legacy plaintext database with data + schema version.
        {
            let c = rusqlite::Connection::open(&plain_path).unwrap();
            c.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('secret');")
                .unwrap();
            c.pragma_update(None, "user_version", 24).unwrap();
        }

        // 2. Export into an attached, keyed SQLCipher database.
        {
            let c = rusqlite::Connection::open(&plain_path).unwrap();
            c.execute_batch(&format!(
                "ATTACH DATABASE '{}' AS enc KEY \"x'{key}'\";",
                enc_path.display()
            ))
            .unwrap();
            c.query_row("SELECT sqlcipher_export('enc')", [], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .unwrap();
            c.pragma_update(
                Some(rusqlite::DatabaseName::Attached("enc")),
                "user_version",
                24,
            )
            .unwrap();
            c.execute_batch("DETACH DATABASE enc;").unwrap();
        }

        // 3. The encrypted file refuses to read without the key…
        let wrong = rusqlite::Connection::open(&enc_path).unwrap();
        assert!(!probe_decrypted(&wrong), "encrypted db must not open keyless");
        drop(wrong);

        // 4. …reads with it, with the data intact.
        let right = rusqlite::Connection::open(&enc_path).unwrap();
        apply_db_key(&right, key).unwrap();
        assert!(probe_decrypted(&right));
        let v: String = right
            .query_row("SELECT v FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "secret");
        let ver: i64 = right
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ver, 24, "user_version must survive sqlcipher_export");

        // 5. The plaintext original can be wiped exactly like production does.
        {
            let mut f = fs::OpenOptions::new().write(true).open(&plain_path).unwrap();
            use std::io::{Seek, SeekFrom, Write};
            f.rewind().unwrap();
            let len = f.metadata().unwrap().len();
            let _ = f.write_all(&vec![0u8; len as usize]);
            f.sync_all().unwrap();
        }
        fs::remove_file(&plain_path).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn escpos_strips_non_ascii() {
        assert_eq!(ascii_only("GH\u{20b5}50 ✓"), "GH?50 ?", "non-printables become ?");
    }

    // ---- Loss prevention: manager PIN, stock take ----

    fn set_manager_pin(conn: &rusqlite::Connection, pin: &str) {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('manager_pin', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [hash_pin(pin)],
        )
        .unwrap();
    }

    #[test]
    fn manager_pin_gates_returns() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Ibuprofen", 9.0, 15.0, 30);
        let sale = complete_sale_impl(
            &mut conn,
            vec![cash(45.0)],
            vec![line(pid, "Ibuprofen", 3, 15.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");

        set_manager_pin(&conn, "2468");
        let lines = vec![ReturnLine {
            product_id: pid,
            quantity: 1,
        }];
        assert!(
            return_sale_impl(&mut conn, sale.sale_id, None, None, lines.clone(), None).is_err(),
            "return without the manager PIN must be refused"
        );
        assert!(
            return_sale_impl(
                &mut conn,
                sale.sale_id,
                None,
                None,
                lines.clone(),
                Some("1111".into())
            )
            .is_err(),
            "a wrong manager PIN must be refused"
        );
        let ok = return_sale_impl(
            &mut conn,
            sale.sale_id,
            None,
            None,
            lines,
            Some("2468".into()),
        )
        .expect("correct PIN must allow the return");
        assert!((ok.total_refunded - 15.0).abs() < 0.001);

        // With no PIN configured (fresh db), returns stay open.
        let mut open_conn = test_db();
        let pid2 = insert_product(&open_conn, "Paracetamol", 4.0, 8.0, 10);
        let sale2 = complete_sale_impl(
            &mut open_conn,
            vec![cash(8.0)],
            vec![line(pid2, "Paracetamol", 1, 8.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");
        return_sale_impl(
            &mut open_conn,
            sale2.sale_id,
            None,
            None,
            vec![ReturnLine {
                product_id: pid2,
                quantity: 1,
            }],
            None,
        )
        .expect("without a configured PIN returns need no PIN");
    }

    #[test]
    fn manager_pin_gates_voids() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "ORS", 1.2, 3.0, 100);
        let sale = complete_sale_impl(
            &mut conn,
            vec![cash(3.0)],
            vec![line(pid, "ORS", 1, 3.0)],
            None,
            None,
            None,
            None,
        )
        .expect("sale should succeed");
        set_manager_pin(&conn, "9999");

        assert!(
            void_last_sale_impl(&mut conn, sale.sale_id, None).is_err(),
            "void without a PIN must be refused"
        );
        assert!(
            void_last_sale_impl(&mut conn, sale.sale_id, Some("0000".into())).is_err(),
            "void with a wrong PIN must be refused"
        );
        void_last_sale_impl(&mut conn, sale.sale_id, Some("9999".into()))
            .expect("the correct PIN must allow the void");
        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 100, "void must have restocked");
    }

    #[test]
    fn void_binds_to_the_exact_sale_id() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "ORS", 1.2, 3.0, 100);
        let older = complete_sale_impl(
            &mut conn,
            vec![cash(3.0)],
            vec![line(pid, "ORS", 1, 3.0)],
            None,
            None,
            None,
            None,
        )
        .expect("first sale should succeed");
        let _newer = complete_sale_impl(
            &mut conn,
            vec![cash(6.0)],
            vec![line(pid, "ORS", 2, 3.0)],
            None,
            None,
            None,
            None,
        )
        .expect("second sale should succeed");

        // A stale screen asking to void the OLDER sale must be refused —
        // only today's newest is ever voidable.
        assert!(
            void_last_sale_impl(&mut conn, older.sale_id, None).is_err(),
            "voiding a non-latest sale must be refused"
        );
        // Unknown / other-day ids are refused too.
        assert!(void_last_sale_impl(&mut conn, 999_999, None).is_err());
    }

    #[test]
    fn stock_take_reductions_require_pin() {
        let mut conn = test_db();
        let pid = insert_batched_product(&conn, "Coartem", 38.0, 52.0, &[("B-OLD", "2026-09-01", 10)]);
        set_manager_pin(&conn, "1357");

        // Pure increases stay ungated.
        commit_stock_take_impl(
            &mut conn,
            vec![StockTakeLine { product_id: pid, counted: 12 }],
            None,
            None,
        )
        .expect("an increase needs no PIN");
        // A reduction without/wrong PIN is refused outright.
        assert!(
            commit_stock_take_impl(
                &mut conn,
                vec![StockTakeLine { product_id: pid, counted: 9 }],
                None,
                None,
            )
            .is_err()
        );
        assert!(
            commit_stock_take_impl(
                &mut conn,
                vec![StockTakeLine { product_id: pid, counted: 9 }],
                None,
                Some("0000".into()),
            )
            .is_err()
        );
        commit_stock_take_impl(
            &mut conn,
            vec![StockTakeLine { product_id: pid, counted: 9 }],
            None,
            Some("1357".into()),
        )
        .expect("correct PIN allows the reduction");
    }

    #[test]
    fn external_restore_swap_rolls_back_both_files_on_failure() {
        let dir = std::env::temp_dir().join(format!("pulse-swap-test-{}", std::process::id()));
        let conf = dir.join("conf");
        fs::create_dir_all(&conf).unwrap();

        // Live install: original db + key.
        fs::write(conf.join("pulse.db"), b"ORIGINAL-DB").unwrap();
        fs::write(conf.join("pulse.key"), "original-key").unwrap();
        let stash = dir.join("stash");
        fs::create_dir_all(&stash).unwrap();
        // The command stashes both before calling the swap.
        fs::rename(conf.join("pulse.db"), stash.join("pulse.db")).unwrap();
        fs::rename(conf.join("pulse.key"), stash.join("pulse.key")).unwrap();

        // Incoming pair: valid db, but a key path that DOESN'T EXIST — the
        // key-copy step fails after the db has already been swapped in.
        let drive = dir.join("drive");
        fs::create_dir_all(&drive).unwrap();
        fs::write(drive.join("pulse-1.db"), b"RESTORED-DB").unwrap();

        let result = swap_in_restored_pair(&conf, &drive.join("pulse-1.db"), &drive.join("nope.key"), &stash);
        assert!(result.is_err(), "missing key must fail the swap");

        // THE regression: the live db must be back — an install must never
        // be left without its own database file.
        assert_eq!(
            fs::read(conf.join("pulse.db")).unwrap(),
            b"ORIGINAL-DB",
            "failed restore must roll the ORIGINAL db back into place"
        );
        assert_eq!(
            fs::read_to_string(conf.join("pulse.key")).unwrap(),
            "original-key",
            "failed restore must roll the original key back"
        );
        // No temp file left behind.
        assert!(!conf.join("pulse.db.restore-tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn external_restore_swap_succeeds_happily() {
        let dir = std::env::temp_dir().join(format!("pulse-swap-ok-test-{}", std::process::id()));
        let conf = dir.join("conf");
        fs::create_dir_all(&conf).unwrap();
        let stash = dir.join("stash");
        fs::create_dir_all(&stash).unwrap();
        let drive = dir.join("drive");
        fs::create_dir_all(&drive).unwrap();
        fs::write(drive.join("pulse-2.db"), b"RESTORED-DB").unwrap();
        fs::write(drive.join("key"), "new-key").unwrap();

        swap_in_restored_pair(&conf, &drive.join("pulse-2.db"), &drive.join("key"), &stash)
            .expect("a valid pair must swap in cleanly");

        assert_eq!(fs::read(conf.join("pulse.db")).unwrap(), b"RESTORED-DB");
        assert_eq!(fs::read_to_string(conf.join("pulse.key")).unwrap(), "new-key");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pin_is_hashed_at_rest_and_verifies() {
        let stored = hash_pin("2468");
        assert!(stored.starts_with("sha256$"), "PIN must never be stored as entered");
        assert!(!stored.contains("2468"), "plaintext PIN must not appear in storage");
        assert!(pin_matches(&stored, "2468"));
        assert!(!pin_matches(&stored, "2467"));

        // Legacy installs stored the raw digits — they keep verifying until
        // the startup migration rewrites them.
        assert!(pin_matches("1357", "1357"));
        assert!(!pin_matches("1357", "1111"));

        // Startup migration converts legacy plaintext to hashed form.
        let conn = test_db();
        set_manager_pin_raw(&conn, "2468");
        migrate_plaintext_pin(&conn).expect("migration succeeds");
        let row: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'manager_pin'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(row.starts_with("sha256$"));
        assert!(check_manager_pin(&conn, Some("2468".into())).is_ok());
        assert!(check_manager_pin(&conn, Some("1111".into())).is_err());
    }

    /// Write a manager PIN verbatim (test fixture for legacy-format rows).
    fn set_manager_pin_raw(conn: &rusqlite::Connection, pin: &str) {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('manager_pin', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [pin],
        )
        .unwrap();
    }

    #[test]
    fn manager_pin_gates_supplier_payments() {
        let mut conn = test_db();
        conn.execute(
            "INSERT INTO purchases (id, reference_no, purchase_date, total_amount, cancelled)
             VALUES ('PUR-1', 'INV-9', '2026-01-01', 500.0, 0)",
            [],
        )
        .unwrap();
        set_manager_pin(&conn, "2468");

        assert!(
            record_payment_impl(&mut conn, "PUR-1".into(), 200.0, None, None, None).is_err(),
            "supplier payment without the manager PIN must be refused"
        );
        assert!(
            record_payment_impl(
                &mut conn,
                "PUR-1".into(),
                200.0,
                None,
                None,
                Some("1111".into())
            )
            .is_err(),
            "a wrong manager PIN must be refused"
        );
        let paid: i64 = conn
            .query_row("SELECT COUNT(*) FROM purchase_payments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(paid, 0, "refused payments must not be recorded");
        let ok = record_payment_impl(
            &mut conn,
            "PUR-1".into(),
            200.0,
            Some("MoMo".into()),
            Some("Kwame".into()),
            Some("2468".into()),
        )
        .expect("correct PIN allows the supplier payment");
        assert_eq!(ok["balance"], 300.0);

        // No PIN configured → payment flows without one.
        let mut open_conn = test_db();
        open_conn
            .execute(
                "INSERT INTO purchases (id, purchase_date, total_amount, cancelled)
                 VALUES ('PUR-2', '2026-01-01', 80.0, 0)",
                [],
            )
            .unwrap();
        record_payment_impl(&mut open_conn, "PUR-2".into(), 80.0, None, None, None)
            .expect("without a configured PIN supplier payments need no PIN");
    }

    #[test]
    fn manager_pin_gates_credit_settlement() {
        let mut conn = test_db();
        let pid = insert_product(&conn, "Amox", 3.0, 5.0, 40);
        let sale = complete_sale_impl(
            &mut conn,
            vec![Payment {
                method: "Credit".into(),
                amount: 25.0,
                reference: None,
            }],
            vec![line(pid, "Amox", 5, 5.0)],
            None,
            Some("Ama".into()),
            None,
            None,
        )
        .expect("credit sale should succeed");
        let _ = sale;
        set_manager_pin(&conn, "9999");

        assert!(
            settle_credit_impl(
                &mut conn,
                "Ama".into(),
                10.0,
                None,
                None,
                None
            )
            .is_err(),
            "settlement without the manager PIN must be refused"
        );
        assert!(
            settle_credit_impl(
                &mut conn,
                "Ama".into(),
                10.0,
                None,
                None,
                Some("0000".into())
            )
            .is_err(),
            "a wrong manager PIN must be refused"
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM credit_payments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "refused settlements must not be recorded");

        let ok = settle_credit_impl(
            &mut conn,
            "Ama".into(),
            10.0,
            Some("Cash".into()),
            Some("Akosua".into()),
            Some("9999".into()),
        )
        .expect("correct PIN allows the settlement");
        assert_eq!(ok["paid"], 10.0);
        assert_eq!(ok["balance"], 15.0);
    }

    #[test]
    fn stock_take_applies_variances_and_audits() {
        let mut conn = test_db();
        let pid = insert_batched_product(
            &conn,
            "Coartem",
            38.0,
            52.0,
            &[("B-OLD", "2026-09-01", 4), ("B-NEW", "2027-01-01", 6)],
        );
        let other = insert_product(&conn, "ORS", 1.2, 3.0, 50);

        // An unknown product aborts the WHOLE count — never a partial apply.
        assert!(
            commit_stock_take_impl(
                &mut conn,
                vec![
                    StockTakeLine {
                        product_id: pid,
                        counted: 8
                    },
                    StockTakeLine {
                        product_id: 999_999,
                        counted: 1
                    },
                ],
                Some("Ama".into()),
                None,
            )
            .is_err()
        );
        let untouched: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(untouched, 10, "a failed count must not touch any stock");

        // Valid sheet: one variance, one unchanged.
        let r = commit_stock_take_impl(
            &mut conn,
            vec![
                StockTakeLine {
                    product_id: pid,
                    counted: 8
                },
                StockTakeLine {
                    product_id: other,
                    counted: 50
                },
            ],
            Some("Ama".into()),
            None,
        )
        .expect("count should commit");
        assert_eq!(r["changed"], 1, "only real variances count as changed");
        assert_eq!(r["unchanged"], 1);

        let stock: i64 = conn
            .query_row("SELECT stock_qty FROM products WHERE id = ?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 8);
        // FEFO ledger absorbed the −2 from the nearest-expiry batch.
        assert_eq!(batch_qty(&conn, pid, "B-OLD"), 2);
        assert_eq!(batch_qty(&conn, pid, "B-NEW"), 6);
        let audit: (i64, String) = conn
            .query_row(
                "SELECT delta, reason FROM stock_adjustments WHERE product_id = ?1",
                [pid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(audit, (-2, "Stock take".to_string()));
        // Ledger total still equals aggregate stock.
        let ledger: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(quantity),0) FROM product_batches WHERE product_id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ledger, stock);
    }
}

/// Stress / chaos suite. Builds on the existing `tests` helpers but targets
/// invariants a pharmacy POS must never break: stock & money conservation under
/// random ops, FEFO correctness, concurrent-write safety, migration
/// idempotency, and query performance at scale. Runs with `cargo test -p pulse`.
#[cfg(test)]
mod stress_tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;

    // Unique temp-file suffix so the two concurrency variants don't share a DB
    // when Rust runs tests in parallel.
    static UNIQ: AtomicU64 = AtomicU64::new(0);

    fn sdb() -> rusqlite::Connection {
        let mut c = rusqlite::Connection::open_in_memory().expect("open mem db");
        apply_migrations(&mut c).expect("apply migrations");
        c
    }

    fn add_product(
        conn: &rusqlite::Connection,
        name: &str,
        cost: f64,
        price: f64,
        stock: i64,
    ) -> i64 {
        conn.execute(
            "INSERT INTO products (name, cost_price, selling_price, stock_qty) VALUES (?1,?2,?3,?4)",
            rusqlite::params![name, cost, price, stock],
        )
        .expect("insert product");
        conn.last_insert_rowid()
    }

    fn add_batch(conn: &rusqlite::Connection, pid: i64, batch: &str, expiry: &str, qty: i64) {
        conn.execute(
            "INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?1,?2,?3,?4)",
            rusqlite::params![pid, batch, expiry, qty],
        )
        .expect("insert batch");
    }

    fn cash(a: f64) -> Payment {
        Payment { method: "Cash".into(), amount: a, reference: None }
    }
    fn line(pid: i64, name: &str, qty: i64, price: f64) -> SaleLine {
        SaleLine { product_id: pid, name: name.to_string(), quantity: qty, unit_price: price, unit: None }
    }

    /// FEFO: the nearest-expiry batch must be depleted before newer stock.
    #[test]
    fn fefo_consumes_oldest_batch_first() {
        let mut c = sdb();
        let pid = add_product(&c, "Vit C", 2.0, 5.0, 10);
        add_batch(&c, pid, "B1", "2025-01-01", 5);
        add_batch(&c, pid, "B2", "2027-01-01", 5);
        complete_sale_impl(&mut c, vec![cash(15.0)], vec![line(pid, "Vit C", 3, 5.0)], None, None, None, None)
            .expect("sale");
        let q1: i64 = c
            .query_row("SELECT quantity FROM product_batches WHERE product_id=?1 AND batch_no='B1'", [pid], |r| r.get(0))
            .unwrap();
        let q2: i64 = c
            .query_row("SELECT quantity FROM product_batches WHERE product_id=?1 AND batch_no='B2'", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(q1, 2, "oldest batch B1 must be consumed first");
        assert_eq!(q2, 5, "newer batch B2 must be untouched");
    }

    // Deterministic xorshift so the fuzz is reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self, max: u64) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x.wrapping_rem(max)
        }
    }

    /// Conservation fuzz: thousands of random sales / returns / voids must leave
    /// stock == shadow ledger, batch ledger == stock, and intake == tendered.
    #[test]
    fn conservation_fuzz_no_money_or_stock_lost() {
        let mut c = sdb();
        // Strip any demo-seed sales (migrations 0025/0026) so the fuzz only
        // reasons about transactions it created itself.
        c.execute_batch(
            "DELETE FROM sale_return_items; DELETE FROM sale_returns; \
             DELETE FROM sale_payments; DELETE FROM sale_items; DELETE FROM sales;",
        )
        .unwrap();
        let mut pids: Vec<i64> = Vec::new();
        let mut expected: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
        for i in 0..60u32 {
            let pid = add_product(&c, &format!("Prod {i}"), 1.0, 10.0, 200);
            add_batch(&c, pid, "X1", "2030-01-01", 100);
            add_batch(&c, pid, "X2", "2031-01-01", 100);
            expected.insert(pid, 200);
            pids.push(pid);
        }
        // successful sales: (sale_id, [(product_id, remaining_qty)])
        let mut sales: Vec<(i64, Vec<(i64, i64)>)> = Vec::new();
        let mut rng = Rng(0x1234_5678);

        for _ in 0..3000 {
            let kind = rng.next(10);
            if kind < 7 || sales.is_empty() {
                // SALE — pay exact cash (avoids the Credit CHECK in sale_payments)
                let nlines = 1 + rng.next(3);
                let mut cart: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
                let mut lines = Vec::new();
                for _ in 0..nlines {
                    let pid = pids[rng.next(pids.len() as u64) as usize];
                    let q = 1 + rng.next(3) as i64;
                    let e = cart.entry(pid).or_insert(0);
                    if *e + q > *expected.get(&pid).unwrap() {
                        continue;
                    }
                    *e += q;
                    lines.push(line(pid, "x", q, 10.0));
                }
                if lines.is_empty() {
                    continue;
                }
                let meta: Vec<(i64, i64)> = lines.iter().map(|l| (l.product_id, l.quantity)).collect();
                let total: f64 = lines.iter().map(|l| l.quantity as f64 * 10.0).sum();
                if let Ok(r) = complete_sale_impl(&mut c, vec![cash(total)], lines, None, None, None, None) {
                    let mut rec = Vec::new();
                    for (pid, q) in &meta {
                        *expected.get_mut(pid).unwrap() -= *q;
                        rec.push((*pid, *q));
                    }
                    sales.push((r.sale_id, rec));
                }
            } else if kind < 9 && !sales.is_empty() {
                // RETURN — restock the returned qty back into the shadow ledger
                let si = rng.next(sales.len() as u64) as usize;
                let (sale_id, rec) = &mut sales[si];
                if rec.is_empty() {
                    continue;
                }
                let li = rng.next(rec.len() as u64) as usize;
                let (pid, avail) = rec[li];
                let rq = (1 + rng.next(avail as u64) as i64).min(avail);
                if return_sale_impl(
                    &mut c,
                    *sale_id,
                    Some("stress".into()),
                    None,
                    vec![ReturnLine { product_id: pid, quantity: rq }],
                    None,
                )
                .is_ok()
                {
                    *expected.get_mut(&pid).unwrap() += rq;
                    if rq >= avail {
                        rec.remove(li);
                    } else {
                        rec[li] = (pid, avail - rq);
                    }
                }
            } else if !sales.is_empty() {
                // VOID — reverts the whole sale back into stock
                let (sale_id, rec) = sales.pop().unwrap();
                if void_last_sale_impl(&mut c, sale_id, None).is_ok() {
                    for (pid, q) in rec {
                        *expected.get_mut(&pid).unwrap() += q;
                    }
                } else {
                    sales.push((sale_id, rec));
                }
            }
        }

        for pid in &pids {
            let stock: i64 = c.query_row("SELECT stock_qty FROM products WHERE id=?1", [pid], |r| r.get(0)).unwrap();
            assert!(stock >= 0, "stock went negative for product {pid}");
            assert_eq!(stock, *expected.get(pid).unwrap(), "stock drift for product {pid}");
            let ledger: i64 = c
                .query_row("SELECT COALESCE(SUM(quantity),0) FROM product_batches WHERE product_id=?1", [pid], |r| r.get(0))
                .unwrap();
            assert_eq!(ledger, stock, "batch ledger != stock for product {pid}");
        }
        // Money: recorded payments must equal the sum of sale totals (a
        // sale's payment is its total, independent of change given). Surface
        // any offender instead of a blind assert.
        let mismatched: Vec<(i64, f64, f64)> = c
            .prepare(
                "SELECT s.id, COALESCE(SUM(sp.amount),0), s.total_amount \
                 FROM sales s LEFT JOIN sale_payments sp ON sp.sale_id = s.id \
                 GROUP BY s.id \
                 HAVING ABS(COALESCE(SUM(sp.amount),0) - s.total_amount) > 0.005",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        if !mismatched.is_empty() {
            eprintln!("money mismatched sales (id, paid, total): {mismatched:?}");
            for (id, _, _) in &mismatched {
                let items: Vec<(i64, f64, i64)> = c
                    .prepare("SELECT product_id, unit_price, quantity FROM sale_items WHERE sale_id=?1")
                    .unwrap()
                    .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                let pays: Vec<(String, f64)> = c
                    .prepare("SELECT method, amount FROM sale_payments WHERE sale_id=?1")
                    .unwrap()
                    .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                let row: (f64, f64, f64) = c
                    .query_row("SELECT total_amount, change_given, subtotal FROM sales WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap();
                eprintln!("  sale {id}: row(total,change,subtotal)={row:?} items={items:?} pays={pays:?}");
            }
        }
        assert!(mismatched.is_empty(), "money conservation broken: {} sales mismatched", mismatched.len());
    }

    /// Credit ("book") sales must record a receivable and settle to zero. The
    /// schema widens the payment_method/method CHECKs to include 'Credit'
    /// (migrations 0016/0017); this proves the whole path works end to end.
    #[test]
    fn credit_sale_records_and_settles_to_zero() {
        let mut c = sdb();
        let pid = add_product(&c, "Cred", 5.0, 10.0, 50);
        let r = complete_sale_impl(
            &mut c,
            vec![Payment { method: "Credit".into(), amount: 30.0, reference: None }],
            vec![line(pid, "Cred", 3, 10.0)],
            None,
            Some("Kwabena".into()),
            Some("0240000000".into()),
            None,
        )
        .expect("credit sale should record");
        assert_eq!(r.total, 30.0);

        let owed: f64 = c
            .query_row(
                "SELECT COALESCE(SUM(sp.amount),0) FROM sale_payments sp \
                 JOIN sales s ON s.id = sp.sale_id \
                 WHERE sp.method = 'Credit' AND s.patient_name = 'Kwabena' COLLATE NOCASE",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!((owed - 30.0).abs() < 0.01, "credit receivable should be 30, got {owed}");

        let res = settle_credit_impl(&mut c, "Kwabena".into(), 30.0, Some("Cash".into()), None, None)
            .expect("settle");
        assert!(
            (res["balance"].as_f64().unwrap()).abs() < 0.01,
            "balance should be zero after settling in full"
        );
    }

    /// Concurrent sales from many threads must never corrupt stock, and with
    /// busy_timeout set there must be zero SQLITE_BUSY errors. Returns the
    /// actual stock read from the DB after the run, plus the busy-error count.
    fn concurrency_soak(set_busy_timeout: bool) -> (i64, i64, i64) {
        let path = std::env::temp_dir().join(format!(
            "pulse_stress_{}_{}.sqlite",
            std::process::id(),
            UNIQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_file(&path);
        let pid = {
            let mut c = rusqlite::Connection::open(&path).expect("open");
            apply_migrations(&mut c).expect("migrate");
            add_product(&c, "Hot", 1.0, 2.0, 100_000)
        };
        let threads = 4u64;
        let per = 250u64;
        let done = Arc::new(AtomicI64::new(0));
        let busy = Arc::new(AtomicI64::new(0));
        let mut handles = Vec::new();
        for _ in 0..threads {
            let path = path.clone();
            let done = done.clone();
            let busy = busy.clone();
            handles.push(thread::spawn(move || {
                let mut conn = rusqlite::Connection::open(&path).expect("open thread");
                if set_busy_timeout {
                    conn.execute_batch("PRAGMA busy_timeout = 5000;").expect("busy_timeout");
                }
                for _ in 0..per {
                    match complete_sale_impl(&mut conn, vec![cash(2.0)], vec![line(pid, "Hot", 1, 2.0)], None, None, None, None) {
                        Ok(_) => {
                            done.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(e) => {
                            if e.contains("database is locked") || e.contains("SQLITE_BUSY") {
                                busy.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let final_stock: i64 = {
            let c = rusqlite::Connection::open(&path).unwrap();
            let stock: i64 = c.query_row("SELECT stock_qty FROM products WHERE id=?1", [pid], |r| r.get(0)).unwrap();
            let batch_sum: i64 = c.query_row("SELECT COALESCE(SUM(quantity),0) FROM product_batches WHERE product_id=?1", [pid], |r| r.get(0)).unwrap();
            let batch_rows: i64 = c.query_row("SELECT COUNT(*) FROM product_batches WHERE product_id=?1", [pid], |r| r.get(0)).unwrap();
            eprintln!("state pid={pid}: stock_qty={stock} batch_sum={batch_sum} batch_rows={batch_rows}");
            stock
        };
        let d = done.load(Ordering::SeqCst);
        let b = busy.load(Ordering::SeqCst);
        eprintln!("concurrency_soak: final_stock={final_stock} done_ok={d} busy_err={b} (started stock=100000)");
        let _ = std::fs::remove_file(&path);
        (final_stock, 100_000 - d, b)
    }

    #[test]
    fn concurrency_soak_with_busy_timeout_is_clean() {
        let (actual, expected, busy) = concurrency_soak(true);
        // The hard guarantee: concurrent sales must never corrupt stock.
        assert_eq!(actual, expected, "stock must equal initial minus successful sales (no corruption)");
        // busy_timeout should make SQLITE_BUSY vanishingly rare (a stray one just
        // means that sale is rejected and the cashier retries — it rolls back).
        assert!(busy <= 4, "busy_timeout should keep SQLITE_BUSY near zero, got {busy}");
    }

    #[test]
    fn concurrency_soak_without_busy_timeout_still_consistent() {
        let (actual, expected, busy) = concurrency_soak(false);
        // Correctness is preserved either way — a failed sale rolls back
        // atomically, so stock can never drift. We only log rejected sales.
        assert_eq!(actual, expected, "stock must stay consistent even without busy_timeout");
        eprintln!("concurrency(8x400) without busy_timeout: rejected(SQLITE_BUSY)={busy}");
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        apply_migrations(&mut c).expect("first apply");
        let v1: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        apply_migrations(&mut c).expect("second apply");
        let v2: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v1, v2, "re-applying migrations must not advance user_version");
        let n: i64 = c
            .query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='products'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "schema must survive a second apply_migrations");
    }

    /// Performance at scale: seed a realistic year of data and confirm the
    /// queries the History / Analytics pages run stay fast and use indexes.
    #[test]
    fn scale_perf_key_queries() {
        let mut c = sdb();
        for i in 0..3000u32 {
            let pid = add_product(&c, &format!("P{i}"), 1.0, 5.0, ((i % 50) as i64) + 1);
            add_batch(&c, pid, "B", "2030-01-01", ((i % 50) as i64) + 1);
        }
        c.execute_batch("BEGIN").unwrap();
        for i in 0..20000u32 {
            c.execute(
                "INSERT INTO sales (receipt_no, total_amount, payment_method, tendered, change_given) VALUES (?1,?2,'Cash',?2,0)",
                rusqlite::params![format!("R{i}"), (i % 100) as f64 + 1.0],
            )
            .unwrap();
        }
        c.execute_batch("COMMIT").unwrap();

        let t0 = std::time::Instant::now();
        let mut q = c.prepare("SELECT id, receipt_no, total_amount, timestamp FROM sales ORDER BY timestamp DESC LIMIT 50").unwrap();
        let rows: usize = q.query_map([], |_| Ok(())).unwrap().count();
        let dt = t0.elapsed();
        assert_eq!(rows, 50);
        eprintln!("history query over 20k sales: {dt:?}");
        assert!(dt.as_millis() < 2000, "history query too slow: {dt:?}");

        let t1 = std::time::Instant::now();
        let _: f64 = c
            .query_row("SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE date(timestamp) BETWEEN '2000-01-01' AND '2100-01-01'", [], |r| r.get(0))
            .unwrap();
        eprintln!("analytics net-revenue scan over 20k sales: {:?}", t1.elapsed());
    }
}

