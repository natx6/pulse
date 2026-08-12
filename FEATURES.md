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
- Left sidebar navigation: POS, Inventory, Restocking, Reports, Settings.
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
  goes on the receipt), no patient database required.
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
- Inventory Intake (F2 from anywhere): scan or enter a barcode, quantity,
  batch/lot, expiry date, supplier, unit of measure, unit cost, retail price.
  Existing product = stock added; unknown barcode = new product created.
- Quick-add for unknown barcodes from the POS.
- Units of measure: every product carries a unit label (strip of 6,
  bottle of 100, sachet…) shown on cards, cart lines, and receipts.
- Batch number, expiry date, cost and selling price per product.

## 4. Restocking & requisitions

- Two views: **Stock** (inventory table + Intake) and **Requisitions**.
- **Requisitions (procurement)**: create a requisition (REQ-YYYYMMDD-NNN)
  from any catalog product — search, pick, set quantity and optional unit
  cost, optional supplier. Open requisitions list with status.
- **Receive (partial or full)**: open a requisition, enter what actually
  arrived per line (suppliers often deliver half an order in Ghana), one tap
  adds it to stock atomically and updates unit cost. Statuses: Open →
  Partially Received (x/y) → Received when every line is complete. Outstanding
  quantities stay tracked on the open requisition.
- Requisitions can be created from the POS via the one-tap Order button.

## 5. Reports (Analytics)

- Date range: Today / Yesterday / This Week / This Month / Custom dates.
- KPIs: revenue, transaction count, items sold, gross profit (uses stored
  cost price).
- Breakdowns: by payment method (Cash/Card/MoMo — split payments counted
  per method), by operator, by category.
- Top products (by quantity), recent sales list (click a receipt number to
  reprint the receipt).
- Stock health: low stock, expiring ≤ 60 days, expired, and **slow movers**
  (products with no sale in 90 days, ranked by cost value — cash tied up on
  the shelf).
- Export CSV: one file with all sections, written to `exports/` next to the
  database (path shown in the UI).
- Backup button: WAL-safe copy of the database to `backups/` (path shown).

## 6. Settings & operations

- Pharmacy name (shown in the top bar and on receipts), tax rate, receipt
  footer, operator name.
- Operator chip in the sidebar: tap to change who is on duty; the operator's
  name is stamped on every sale and feeds the per-operator report. No login,
  no passwords — the data exists, the flow forces nothing.

## 7. Keyboard map

- F9 / F10 / F11 — Cash / Card / MoMo: on POS with items they open checkout
  pre-selected; inside the payment screen they switch method.
- F2 — Inventory Intake from anywhere.
- Ctrl+K — focus top search. Ctrl+F — focus POS scan/search.
- Esc — close modal. Enter — confirm (and scan-equivalent in the POS box).

## 8. Data & reliability

- SQLite, WAL journal mode. Database, backups, and CSV exports live in the
  OS config dir (`~/.config/com.pulse.pharmacy/` on Linux).
- **Automatic backups**: after every 10th sale and on app exit (plus the
  manual button) — WAL-safe via the SQLite online backup API, so a power cut
  mid-shift can never cost more than the current day's partial data.
- Schema: products (name, barcode unique+indexed, category, manufacturer,
  supplier, strength, unit, Rx flag, batch, expiry, cost, retail, stock,
  reorder level), sales (receipt no, total, primary payment method, operator,
  timestamp), sale_payments (per-method amount + optional reference),
  sale_items (snapshot of name/unit/price, quantity), purchase orders +
  items, settings key/value.
- Demo seed catalog ships with the first migration (Coartem, Amoxicillin,
  Paracetamol, Ibuprofen, Lisinopril, Amlodipine, Metformin, ORS) with real
  expiry/status variety — deletable.

## 9. Deliberately NOT included (v1 scope decisions)

- No login / passwords / user roles (operator name only).
- No credit sales ledger (planned add-on).
- No NHIS/insurance claims or e-invoicing.
- No live MoMo API integration (merchant number display planned).
- No thermal-printer direct driver (browser print only).
- No patient database / prescriptions lifecycle (patient name on receipt only).
- No multi-branch sync, no cloud.
- No internet required for any feature.

## 10. Build & run

- `npm install`, then `npm run tauri dev` (first Rust build takes several
  minutes; afterwards it hot-reloads). Production binary: `npm run tauri
  build`. Linux prerequisites: webkit2gtk4.1-devel, openssl-devel,
  librsvg2-devel, libxdo-devel, patchelf, Rust toolchain.
- Bundle is ~64 KB gzipped JS + ~7 KB CSS; release binary is a few MB
  (opt-level=s, lto, strip).
