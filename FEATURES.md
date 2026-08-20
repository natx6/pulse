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
- Left sidebar navigation: POS, Inventory, Requisitions, Reports, Expenses,
  and Support, with Settings and the operator switcher pinned below a
  divider at the bottom.
- Top bar: pharmacy name, search field (Ctrl+K focuses it; matches products
  and patients live as you type), "New Prescription" button (holds current
  order if any, clears the counter, focuses the scanner), Barcode Scan
  shortcut (jumps to POS and focuses the scanner), and a notification bell —
  its badge is a live count of low-stock + expiring + expired products and
  open purchase orders, and its dropdown links straight to Inventory or
  Requisitions.
- Color-coded theme (Material green `#006c49` primary, red errors), Inter
  font, Material Symbols icons — all self-hosted, zero network dependency.
- Full keyboard operation (see section 7).

## 2. POS (point of sale)

- **Barcode scanning**: any USB HID scanner works plug-and-play. Scans are
  detected as fast keystroke bursts + Enter; the item is looked up and added
  to the cart instantly with a success beep. Typing in the search box never
  triggers a false scan. Unknown barcodes open a quick-add screen.
- **Search**: type anywhere in the POS search box; exact barcode match adds
  to cart, otherwise live product filtering. Auto-focused whenever the POS
  screen opens.
- **Product grid**: cards show name, strength, unit of measure (blister/
  strip/bottle/sachet), manufacturer, Rx/OTC badge, price in GH₵, live stock
  status (green = healthy, yellow = at/below reorder level, red = out of
  stock / expired / expiring within 30 days).
- **Reorder from the card**: low/out-of-stock cards show an "Order" button
  that opens a small confirm dialog pre-filled with a quantity (from the
  reorder level, or 10), editable before you commit — a second click ("Add
  to Requisition") creates the order, with a confirmation flash.
- **Cart**: quantity steppers, line totals, remove, Clear All, "Add Manual
  Item" (products without barcodes), Hold Order (saves the cart, restorable
  via "Restore Held Order"), unit of measure shown per line.
- **Customer header**: inline patient name entry (walk-in by default; name
  goes on the receipt). Every sale stamps the patient's name/phone and builds
  a patient history (search the top bar, see section 5).
- **Totals**: live subtotal, an automatic discount if the attached patient
  has a discount tier set (section 6), tax (rate from Settings), total. All
  amounts in GH₵.
- **Payments** (all one tap, no dialogs):
  - Cash (default) — Exact pre-selected, quick-tender amounts, change
    calculated, custom amount entry. F9.
  - Card — recorded as Card, optional card reference. F10.
  - Mobile Money — recorded as MoMo, optional MoMo transaction ID
    (the 12-digit reference you quote in disputes). F11.
  - **Split payments** — a "Split" toggle settles one sale across methods
    (e.g. GH₵ 50 Cash + GH₵ 70 MoMo): per-method amounts with optional
    references, remainder auto-fill, change only from the last method.
  - **Book (credit)** — sell on the customer's book (requires a customer
    name); the balance lands in Reports → Customer credit, where it can be
    settled later. Works in splits too (e.g. GH₵ 30 Cash + rest on book).
  - **MoMo number** — when Mobile Money is selected and a number is set in
    Settings, the payment screen and receipt show where the customer pays.
  - Every payment line (method, amount, reference) is stored per sale and
    printed on the receipt.
- **Receipt**: on-screen receipt preview after every sale, printable via the
  OS print dialog. Shows pharmacy name, receipt number, items with units,
  subtotal, any patient discount, tax, total, amount paid, change, payment
  method/reference (MoMo number too when relevant), and footer from
  Settings — the operator's name is not on it.
- **Atomic sales**: a sale (receipt + items + stock deduction) commits as a
  single SQLite transaction in Rust — a crash or power cut can never produce
  a half-recorded sale. Overselling is rejected before anything is written.

## 3. Inventory

- Searchable, sortable stock table: item name, batch number, supplier,
  barcode, expiry date, live quantity, color-coded status.
- Status logic: green = stock above reorder level; yellow = at/below reorder
  level; red = out of stock, expired, or expiring within 30 days.
- **Controlled drugs**: products marked "Controlled drug" (via import or the
  catalog) carry a red **C** badge in Inventory and on the POS grid, and feed
  the Controlled Drug Register on Reports.
- **Receive Stock** (F2 from anywhere): scan or enter a barcode, quantity,
  batch/lot, expiry date, supplier, unit of measure, unit cost, retail price.
  Existing product = stock added; unknown barcode = new product created.
- **Import Stock** (from Excel/CSV): pick a file exported from the old
  system, the app auto-maps columns to fields (name, barcode, prices,
  quantity, category, and more — remap anything it guesses wrong), previews
  the first rows, then commits everything in one transaction: a matching
  barcode or name updates price and adds quantity, anything unmatched
  creates a new product. A backup is taken automatically first; up to 5,000
  rows per file.
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

- **New Purchase** (PUR-YYYYMMDD-NNN): supplier master (add on the fly),
  reference # (waybill/invoice), pay term, per-line unit cost, discount %,
  selling price + live margin, expiry/mfg dates, order-level discount. Status:
  Draft → Ordered → Received; saving as **Received** lands stock in one
  atomic transaction.
- **Reorder helper**: "Add low & out-of-stock" pulls every item at or below
  its reorder level into the order in one click; scanning a barcode adds the
  line directly.
- **Print order**: A4 purchase order form (pharmacy name from Settings,
  supplier contact, lines, totals, signature blocks) — the artifact to read
  out or send to the supplier.
- **Edit / Cancel**: Draft/Ordered orders can be edited (lines replaced,
  totals recomputed server-side) until any stock is received; unwanted orders
  cancel with a two-tap confirm and drop out of the list and the bell.
- **Receive (partial or full)**: open an order, enter what actually arrived
  per line (suppliers often deliver half an order in Ghana) plus the
  supplier's **invoice cost** — mismatches vs the ordered price are flagged
  as a three-way-match warning. One tap adds it to stock atomically; status
  becomes Partially Received (x/y) then Received when every line is complete.
- **Payments**: record payments per invoice (Cash / Mobile Money / Bank /
  Cheque) with history; the list shows each order's outstanding **Balance**
  (overpaying is rejected server-side).
- Orders can be created from the POS via the Order button on low/out-of-stock
  cards (opens a pre-filled confirm dialog; a second click creates the
  order).

## 5. Reports (Analytics)

- Date range: Today / Yesterday / This Week / This Month / Custom dates.
- **Operator filter**: a dropdown (All | operators from Settings | any legacy
  name found on sales in the range) filters every section — KPIs, payment
  breakdown, categories, top products, recent sales, returns, cash-up. The
  CSV export and its filename carry the operator (`sales-today-ama.csv`).
- KPIs: **Gross Sales / Returns / Net Revenue** (refunds subtracted honestly),
  transaction count, items sold, gross profit (uses stored cost price),
  total expenses, and net profit (gross profit minus expenses).
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
  see cash sales minus cash refunds minus cash expenses (see Expenses,
  section 10 — only expenses paid in Cash count against the till), enter
  what was counted, and save the variance (green/red) to a per-day history.
- **Recent stock adjustments**: the last 10 audit entries (product, ±qty,
  reason, operator).
- Stock health: low stock, expiring ≤ 60 days, expired, and **slow movers**
  (products with no sale in 90 days, ranked by cost value — cash tied up on
  the shelf).
- **Controlled Drug Register**: per-product summary (stock on hand, received,
  dispensed, returned, adjusted in the range) plus a chronological transaction
  log — the record a Ghana pharmacy must keep for controlled substances.
- **Customer Credit (book)**: every customer's outstanding balance from
  credit sales, with one-tap Settle (amount + method, overpaying rejected);
  a per-payment history is kept.
- **Supplier Balances**: the flip side of Customer Credit — per-supplier
  purchased / paid / balance across every purchase order on file (invoice
  count, oldest open date), so you can see who you still owe.
- Export CSV: one file with all sections, saved wherever you pick in the
  native Save dialog (path shown in the UI after export).
- Backup button: WAL-safe copy of the database to `backups/` (path shown).

## 6. Patient history

- The top-bar search matches products **and** patients (name or phone).
  Clicking a patient opens their history: total visits, last visit, and the
  last 10 sales with receipt reprint.
- Patients are created automatically at checkout whenever a name is attached
  to a sale; the sale keeps a name/phone snapshot, so history never breaks
  even if a patient record is cleaned up.
- **Discount tier**: each patient can carry a standing discount (0-100%), set
  from their history card. It applies automatically to the subtotal of their
  next sale at checkout and shows as a line on the receipt.

## 7. Settings & operations

- Pharmacy name (shown in the top bar and on receipts), tax rate, receipt
  footer, operator name, **Mobile Money number** (shown at MoMo checkout and
  printed on receipts).
- Operator chip in the sidebar: tap to change who is on duty; the operator's
  name is stamped on every sale and feeds the per-operator report. No login,
  no passwords — the data exists, the flow forces nothing.
- **Backups card**: every backup in `backups/` (name, size, date) with a
  two-tap Restore. Restoring snapshots the current database to
  `backups/pre-restore-<ts>.db` first, swaps the file, and restarts the app.
  Auto-backups keep the newest 20 files.
- **Dark mode**: a toggle in an Appearance card switches the whole app
  between light and dark via a CSS custom-property token system (colors
  only, no separate dark-mode components), saved as a setting so it
  persists between launches.

## 8. Keyboard map

- F8 — Hold the current order (POS screen only; no-op with an empty cart).
- F9 / F10 / F11 — Cash / Card / MoMo: on POS with items they open checkout
  pre-selected; inside the payment screen they switch method.
- F2 — Inventory Intake from anywhere.
- Ctrl+K — focus top search.
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
  supplier, strength, unit, Rx flag, FDA reg no, controlled flag, batch,
  expiry, cost, retail, stock, reorder level, active flag), sales (receipt
  no, total, primary payment method, operator, patient name/phone snapshot,
  timestamp), sale_payments (per-method amount + optional reference),
  sale_items (snapshot of name/unit/price, quantity), sale_returns +
  sale_return_items, stock_adjustments (audit log), cash_ups (per-day till
  records), patients (search index, discount_tier), suppliers, purchases +
  purchase_items (orders with qty_received, cancelled flag),
  purchase_payments (supplier invoice payments), credit_payments (customer
  book settlements), expenses (category, description, amount, payment
  method, operator, timestamp), settings key/value.
- Migrations run through an in-app runner keyed by PRAGMA user_version
  (currently v21 — 21 migration files) — the plugin's own runner and its
  leftover `_sqlx_migrations` table were dropped.
- Fonts (Inter + Material Symbols) are self-hosted in `public/fonts/` — no
  Google Fonts at runtime.
- Demo seed catalog ships with the first migration (Coartem, Amoxicillin,
  Paracetamol, Ibuprofen, Lisinopril, Amlodipine, Metformin, ORS) with real
  expiry/status variety — deletable.

## 10. Expenses

Petty cash and running costs — rent, utilities, staff, transport,
maintenance, supplies, licenses, tax, other — tracked separately from stock
purchases.

- **Log an expense**: category (fixed list), description, amount (GH₵), and
  how it was paid (Cash / Card / MoMo), stamped with the operator on duty.
  Each entry can be deleted (two-tap confirm).
- **Date range + by-category breakdown**: filter any range, see a running
  total and a per-category subtotal panel alongside the list.
- **Feeds Reports**: total expenses and net profit (gross profit minus
  expenses) appear as KPI tiles, and cash-paid expenses subtract from Daily
  cash-up's expected till total — Card/MoMo expenses never touch the till,
  so they're excluded from that calculation.

## 11. Support

A compose page, not a ticket system: describe the problem, tap Send, and the
OS mail app opens with a message pre-filled (pharmacy name, staff name, app
version, a device id, timestamp, what you were doing, what went wrong)
addressed to the support email set in Settings — so a report arrives with
context instead of "it's broken." Attach a screenshot before sending if the
problem is visual.

## 12. Deliberately NOT included (v1 scope decisions)

- No login / passwords / user roles (operator name only).
- No NHIS/insurance claims or e-invoicing.
- No live MoMo API integration (the merchant number is displayed; Pulse
  doesn't move money itself).
- No thermal-printer direct driver (browser print only).
- No prescriptions lifecycle / dosing regimens (patient history only).
- No multi-branch sync, no cloud.
- No internet required for any feature.

## 13. Build & run

- `npm install`, then `npm run tauri dev` (first Rust build takes several
  minutes; afterwards it hot-reloads). Production binary: `npm run tauri
  build`. Linux prerequisites: webkit2gtk4.1-devel, openssl-devel,
  librsvg2-devel, libxdo-devel, patchelf, Rust toolchain.
- Bundle is ~76 KB gzipped JS + ~7 KB CSS; release binary is a few MB
  (opt-level=s, lto, strip).
- **Auto-update (tauri-plugin-updater)**: installed builds check
  `releases/latest/download/latest.json` on launch (production only — the
  dev app never checks). A newer release is downloaded, installed and the
  app restarts, with a small progress overlay. Releases are signed with an
  ed25519 keypair (`~/.pulse-updater.key` + password); the private key lives
  in the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and the public key is baked into
  `tauri.conf.json`. The release workflow signs artifacts and assembles
  `latest.json`; publish the draft GitHub Release to roll the update out
  (the repo must be public — private repos return 404 to the app's
  anonymous update check). macOS needs notarization (Apple credentials)
  before Gatekeeper will accept updates.
