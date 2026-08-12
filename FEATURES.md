# Pulse — Complete Feature Inventory

Pulse is a lightweight, offline-first pharmacy management system for the
Ghanaian market, built as a desktop app (Tauri 2 + React + SQLite). Design
ethos: "scan, sell, go" — no long processes, no required forms, everything
reachable in one or two taps. All data lives in a local SQLite database and
the app works fully offline (power cuts and flaky internet are assumed).

---

## 1. Application shell

- Single desktop window titled "Pulse" (pharmacy name shown inside the app is
  editable in Settings and never hard-codes the window title).
- Left sidebar navigation: POS, Inventory, Requisitions, Reports, Settings.
- Top bar: pharmacy name, search field (Ctrl+K focuses it), "New
  Prescription" button (holds current order if any, clears the counter,
  focuses the scanner), Barcode Scan shortcut, notification/history/account
  icons (decorative).
- Color-coded theme (Material green `#006c49` primary, red errors), Inter
  font, Material Symbols icons — all self-hosted, zero network dependency.
- Full keyboard operation (see section 7).

## 2. POS (point of sale)

- **Barcode scanning**: any USB HID scanner works plug-and-play. Scans are
  detected as fast keystroke bursts + Enter; the item is looked up and added
  to the cart instantly with a success beep. Typing in the search box never
  triggers a false scan. Unknown barcodes open a quick-add screen.
- **Search**: type anywhere in the POS search box; exact barcode match adds
  to cart, otherwise live product filtering. Ctrl+F focuses it.
- **Product grid**: cards show name, strength, unit of measure (blister/
  strip/bottle/sachet), manufacturer, Rx/OTC badge, price in GH₵, live stock
  status (green = healthy, yellow = at/below reorder level, red = out of
  stock / expired / expiring within 30 days).
- **One-tap reorder**: low/out-of-stock cards show an "Order" button that
  creates a requisition in one click (quantity pre-filled from the reorder
  level), with a confirmation flash.
- **Cart**: quantity steppers, line totals, remove, Clear All, "Add Manual
  Item" (products without barcodes), Hold Order (saves the cart, restorable
  via "Restore Held Order"), unit of measure shown per line.
- **Customer header**: inline patient name entry (walk-in by default; name
  goes on the receipt). Every sale stamps the patient's name/phone and builds
  a patient history (search the top bar, see section 5).
- **Totals**: live subtotal, tax (rate from Settings), total. All amounts in
  GH₵.
- **Payments** (all one tap, no dialogs):
  - Cash (default) — Exact pre-selected, quick-tender amounts, change
    calculated, custom amount entry. F9.
  - Card — recorded as Card, optional card reference. F10.
  - Mobile Money — recorded as MoMo, optional MoMo transaction ID
    (the 12-digit reference you quote in disputes). F11.
  - **Split payments** — a "Split" toggle settles one sale across methods
    (e.g. GH₵ 50 Cash + GH₵ 70 MoMo): per-method amounts with optional
    references, remainder auto-fill, change only from the last method.
  - Every payment line (method, amount, reference) is stored per sale and
    printed on the receipt.
- **Receipt**: on-screen receipt preview after every sale, printable via the
  OS print dialog. Shows pharmacy name, receipt number, items with units,
  totals, payment method, operator name, footer from Settings.
- **Atomic sales**: a sale (receipt + items + stock deduction) commits as a
  single SQLite transaction in Rust — a crash or power cut can never produce
  a half-recorded sale. Overselling is rejected before anything is written.

## 3. Inventory

- Searchable, sortable stock table: item name, batch number, supplier,
  barcode, expiry date, live quantity, color-coded status.
- Status logic: green = stock above reorder level; yellow = at/below reorder
  level; red = out of stock, expired, or expiring within 30 days.
- **Receive Stock** (F2 from anywhere): scan or enter a barcode, quantity,
  batch/lot, expiry date, supplier, unit of measure, unit cost, retail price.
  Existing product = stock added; unknown barcode = new product created.
- Quick-add for unknown barcodes from the POS.
- Units of measure: every product carries a unit label (strip of 6,
  bottle of 100, sachet…) shown on cards, cart lines, and receipts.
- Batch number, expiry date, cost and selling price per product.
- **Stock adjustments** (row action on hover): a signed quantity change
  (damaged / expired / counting error / returned to supplier / other + note),
  mandatory reason, logged to an audit list on the Reports page. Stock can
  never be adjusted below zero.
- **Archive**: any product can be archived (two-tap confirm) — it disappears
  from the POS and inventory but keeps its sales history. "Show archived"
  lists them with a one-tap Restore.
- **Print Label**: pick a product (or type any barcode) and print a scannable
  Code39 shelf label — completes the loop for QuickAdd products whose fake
  barcodes become printable, scannable labels.

## 4. Requisitions (ordering)

Two clear stock surfaces, no overlap: **Inventory = see + receive**
(what's on the shelf, take deliveries in — F2 anywhere), **Requisitions =
order** (what you've asked suppliers for). The notifications bell covers
what needs attention.

- Create a requisition (REQ-YYYYMMDD-NNN) from any catalog product — search,
  pick, set quantity and optional unit cost, optional supplier. Open
  requisitions list with status.
- **Receive (partial or full)**: open a requisition, enter what actually
  arrived per line (suppliers often deliver half an order in Ghana), one tap
  adds it to stock atomically and updates unit cost. Statuses: Open →
  Partially Received (x/y) → Received when every line is complete. Outstanding
  quantities stay tracked on the open requisition.
- Requisitions can be created from the POS via the one-tap Order button on
  low/out-of-stock cards.

## 5. Reports (Analytics)

- Date range: Today / Yesterday / This Week / This Month / Custom dates.
- **Operator filter**: a dropdown (All | operators from Settings | any legacy
  name found on sales in the range) filters every section — KPIs, payment
  breakdown, categories, top products, recent sales, returns, cash-up. The
  CSV export and its filename carry the operator (`sales-today-ama.csv`).
- KPIs: **Gross Sales / Returns / Net Revenue** (refunds subtracted honestly),
  transaction count, items sold, gross profit (uses stored cost price).
- Breakdowns: by payment method (Cash/Card/MoMo — split payments counted
  per method), by operator, by category.
- Top products (by quantity), recent sales list — each row has a **Return**
  action; today's last sale also shows a two-tap **Void** (deletes it
  entirely and restocks). Click a receipt number to reprint it.
- **Returns**: refund part or all of any sale (per-line quantities, optional
  reason) — the sale stays on record, stock goes back on the shelf, and a
  printable RETURN slip with negative amounts is generated. Reports subtract
  returns from net revenue.
- **Daily cash-up**: pick a day, enter the opening float (remembered per day),
  see cash sales minus cash refunds, enter what was counted, and save the
  variance (green/red) to a per-day history.
- **Recent stock adjustments**: the last 10 audit entries (product, ±qty,
  reason, operator).
- Stock health: low stock, expiring ≤ 60 days, expired, and **slow movers**
  (products with no sale in 90 days, ranked by cost value — cash tied up on
  the shelf).
- Export CSV: one file with all sections, written to `exports/` next to the
  database (path shown in the UI).
- Backup button: WAL-safe copy of the database to `backups/` (path shown).

## 6. Patient history

- The top-bar search matches products **and** patients (name or phone).
  Clicking a patient opens their history: total visits, last visit, and the
  last 10 sales with receipt reprint.
- Patients are created automatically at checkout whenever a name is attached
  to a sale; the sale keeps a name/phone snapshot, so history never breaks
  even if a patient record is cleaned up.

## 7. Settings & operations

- Pharmacy name (shown in the top bar and on receipts), tax rate, receipt
  footer, operator name.
- Operator chip in the sidebar: tap to change who is on duty; the operator's
  name is stamped on every sale and feeds the per-operator report. No login,
  no passwords — the data exists, the flow forces nothing.
- **Backups card**: every backup in `backups/` (name, size, date) with a
  two-tap Restore. Restoring snapshots the current database to
  `backups/pre-restore-<ts>.db` first, swaps the file, and restarts the app.
  Auto-backups keep the newest 20 files.

## 8. Keyboard map

- F9 / F10 / F11 — Cash / Card / MoMo: on POS with items they open checkout
  pre-selected; inside the payment screen they switch method.
- F2 — Inventory Intake from anywhere.
- Ctrl+K — focus top search. Ctrl+F — focus POS scan/search.
- Esc — close modal. Enter — confirm (and scan-equivalent in the POS box).

## 9. Data & reliability

- SQLite, WAL journal mode. Database, backups, and CSV exports live in the
  OS config dir (`~/.config/com.pulse.pharmacy/` on Linux).
- **Automatic backups**: after every 10th sale and on app exit (plus the
  manual button) — WAL-safe via the SQLite online backup API, so a power cut
  mid-shift can never cost more than the current day's partial data. The
  newest 20 backups are kept (timestamped names); restores are two-tap with a
  pre-restore safety snapshot.
- Schema: products (name, barcode unique+indexed, category, manufacturer,
  supplier, strength, unit, Rx flag, batch, expiry, cost, retail, stock,
  reorder level, active flag), sales (receipt no, total, primary payment
  method, operator, patient name/phone snapshot, timestamp),
  sale_payments (per-method amount + optional reference), sale_items
  (snapshot of name/unit/price, quantity), sale_returns + sale_return_items,
  stock_adjustments (audit log), cash_ups (per-day till records), patients
  (search index), purchase orders + items, settings key/value.
- Migrations run through an in-app runner keyed by PRAGMA user_version
  (currently v11) — the plugin's own runner and its leftover
  `_sqlx_migrations` table were dropped.
- Demo seed catalog ships with the first migration (Coartem, Amoxicillin,
  Paracetamol, Ibuprofen, Lisinopril, Amlodipine, Metformin, ORS) with real
  expiry/status variety — deletable.

## 10. Deliberately NOT included (v1 scope decisions)

- No login / passwords / user roles (operator name only).
- No credit sales ledger (planned add-on).
- No NHIS/insurance claims or e-invoicing.
- No live MoMo API integration (merchant number display planned).
- No thermal-printer direct driver (browser print only).
- No prescriptions lifecycle / dosing regimens (patient history only).
- No multi-branch sync, no cloud.
- No internet required for any feature.

## 11. Build & run

- `npm install`, then `npm run tauri dev` (first Rust build takes several
  minutes; afterwards it hot-reloads). Production binary: `npm run tauri
  build`. Linux prerequisites: webkit2gtk4.1-devel, openssl-devel,
  librsvg2-devel, libxdo-devel, patchelf, Rust toolchain.
- Bundle is ~76 KB gzipped JS + ~7 KB CSS; release binary is a few MB
  (opt-level=s, lto, strip).
