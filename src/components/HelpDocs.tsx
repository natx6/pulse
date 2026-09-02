import { useMemo, useState } from "react";

type DocSection = {
  id: string;
  title: string;
  icon: string;
  summary: string;
  body: { heading: string; text: string }[];
  tips?: string[];
};

const DOCS: DocSection[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    icon: "space_dashboard",
    summary: "At-a-glance: today's takings, what's low or expiring, and what's on order.",
    body: [
      { heading: "What it does", text: "Shows today's sales and profit, what should be in the till (including opening float, cash in/out, refunds, cash expenses), and three watch-lists: Low stock (≤ reorder), Expiring soon (≤ 60 days), Expired, plus Open purchases (requisitions not yet received)." },
      { heading: "How to use", text: "1. Open Pulse — you land here. 2. Check the red/yellow pills (Critical/Reorder Soon). 3. Tap a low-stock name to jump to Inventory and reorder. 4. The Cost of stock / Retail footer is live — Cost is 0 until you import buying prices." },
    ],
    tips: ["Greeting shows Good morning/afternoon + operator — no pharmacy suffix.", "Numbers refresh every 60s and after each sale."],
  },
  {
    id: "pos",
    title: "POS — Counter",
    icon: "point_of_sale",
    summary: "Scan or search, add to cart, take payment — the daily sale.",
    body: [
      { heading: "What it does", text: "Search by name, barcode, or supplier (also generic/ingredient after FDA products are saved). Scan a barcode — unknown codes offer Quick Add. Cart respects stock caps and pack sizes. Patient + discount tier, hold/restore, and four payment methods." },
      { heading: "How to use", text: "1. Type in Search or scan. 2. Tap a product (or tap Add pack for a whole carton). 3. Adjust Qty ±. 4. Optional: set Patient (Enter) for credit + discount. 5. Tap Cash/Card/MoMo/Credit. For Cash, enter tendered. 6. Complete Sale → receipt prints if a printer is set. F9/F10/F11 switch pay method; F8 holds, Ctrl+K focuses search." },
      { heading: "Add Manual Item (unknown barcode)", text: "Scanned code not found → Name + Selling Price. With FDA autocomplete on, type 2 letters (e.g. para) and pick a Ghana FDA product — the trailing (Each …) detail is stripped, generic/ingredient is stored so later POS search finds it by either brand or generic." },
    ],
    tips: ["Pack size = how many sell units per supplier carton (1 = single). Unit = what you sell as (Pack, Bottle, Inhaler).", "Credit sales appear in Customers → Outstanding credit, not in Reports."],
  },
  {
    id: "history",
    title: "History",
    icon: "history",
    summary: "Every sale, with reprint, void (today's last) and partial returns.",
    body: [
      { heading: "What it does", text: "Filter by date/patient/receipt. Each row shows receipt, total, method, and operator. Tap to reprint or to open Return/Void." },
      { heading: "How to use", text: "1. Find the sale (date range or receipt no.). 2. Return: tap Return → set Qty per product (capped at sold − alreadyReturned) → Reason → Manager PIN if set → Refund & restock. Stock is added back to the correct FEFO batch. 3. Void: only today's last sale (MAX id, same-day) can be voided — it deletes the sale entirely; everything else must be Returned. 4. Reprint shows the same discount/tax snapshot." },
    ],
    tips: ["A return can be partial and repeated — the cap prevents double-restocking.", "Refunds use the sale's paid ratio, so discounted sales refund what was actually collected."],
  },
  {
    id: "customers",
    title: "Customers",
    icon: "groups",
    summary: "All walk-ins who ever bought, with visit history and credit book.",
    body: [
      { heading: "What it does", text: "Search by name/phone. Each customer shows Total visits, Last visit, per-customer Discount, and Outstanding credit (sale_payments method=Credit + patient opening_balance). Opening a customer shows Last 10 sales (tap to reprint) and a credit card." },
      { heading: "How to use", text: "1. Search a name. 2. Tap a row → Patient view. 3. If Outstanding credit > 0, tap Settle → amount + method (Cash/MoMo/Bank/Cheque) → Manager PIN if set → Record. Shortfalls stay as balance. 4. Import customers (old system) with opening balances via Customers → Import customers." },
    ],
    tips: ["Customers are auto-created on sale — no need to pre-register.", "Supplier import and customer import both support opening balances."],
  },
  {
    id: "inventory",
    title: "Inventory",
    icon: "inventory_2",
    summary: "The shelf: stock, batches (FEFO), reorder, and all ways stock enters.",
    body: [
      { heading: "What it does", text: "Search (Ctrl+K), sort, and see Status (In Stock / Reorder Soon / Critical), Qty, Min, Batch, Supplier, Barcode, Expiry. Rows expand to show per-batch FEFO ledger. Cost of stock = Σ cost_price×qty (0 until buying prices are imported); Retail = Σ selling_price×qty. Pagination is 100/page." },
      { heading: "How to use — hand entry", text: "Inventory → Add Product: type 2 letters → FDA Ghana autocomplete (7,987 DRUG/DRUGS) → pick. Fill Selling* + Stock qty* (always visible); tap More for Barcode/Category (dropdown of existing + New)/Supplier (your wholesaler, not FDA manufacturer)/Strength/Cost/Reorder/Pack/Batch/Expiry (DateField). Add Product creates the product + one batch (stock). Pack size = how many sell units per supplier carton (1 = single). Expiry uses the shared calendar, not the native date picker." },
      { heading: "How to use — bulk", text: "Inventory → Import Stock → pick .xlsx/.csv (≤5,000 rows) → column mapper auto-matches Name of Medication, Sale Price (Base Price), Expiry Date, Quantity, Batch Number, Brand Name → Manufacturer, Category, Medication Type → Category, etc. (now normalized). Preview shows all rows as a scrollable table with an FDA column (Use FDA per row, Apply FDA names to all rows). Stats show new vs update (by barcode/name). Two-tap Import → one transaction + backup." },
      { heading: "How to use — adjustments", text: "Row → tune → Adjust: Quantity change (±, negative needs Manager PIN if set), Reason, Note, Reorder level, Units per pack. Archive needs two taps; Archived toggle shows discontinued items." },
    ],
    tips: ["Barcode is optional; name must be unique case-insensitive.", "Expiry 46665-style serials from Excel are auto-converted to YYYY-MM-DD on import and display."],
  },
  {
    id: "restock",
    title: "Requisitions",
    icon: "shopping_cart",
    summary: "Order from suppliers, receive, and track what you owe.",
    body: [
      { heading: "What it does", text: "Requisitions are supplier purchase orders. Lines show Product, Sell as (Pack/Bottle/Inhaler), Qty, Unit cost, Disc %, Net cost, Sell price, Margin, Line total, Expiry, Batch no. Order discount, Subtotal/Net total, Pay term, Status." },
      { heading: "How to use", text: "1. New Purchase → pick Supplier (or + New) → Reference No. → Date (DateField) → Pay term → Add products (search or Add low & out-of-stock) → set Qty/Unit cost/Sell price/Margin. 2. Save as Ordered/Draft (no stock yet) or Save & Add to Stock (Received) → stock + batches added and margin tracked. 3. Later, open an Ordered requisition → Receive → enter actual received qtys/batches." },
    ],
    tips: ["Supplier here is who you requisition from (Kinapharma etc.), not the FDA manufacturer.", "Sell as is the unit you sell — Pack sale here is independent of Pack size in Inventory."],
  },
  {
    id: "reports",
    title: "Reports",
    icon: "bar_chart",
    summary: "Date-filtered KPIs, VAT/discount, controlled drugs, and supplier balances.",
    body: [
      { heading: "What it does", text: "Presets: Today/Yesterday/7/30/Custom + Operator + Method. KPIs: Sales, Profit, Margin, VAT, Discount, Controlled-drug register. Supplier Balances (opening + purchases − payments). Expenses by category." },
      { heading: "How to use", text: "1. Pick a range. 2. Read KPIs; open Controlled register for DD book. 3. Supplier Balances → Import suppliers (opening balances) where needed. 4. Export CSV writes the whole report (choose where to save) — includes Cost/Retail for the range." },
    ],
    tips: ["Customer Credit was moved — settle credit in Customers, not here.", "Reports are filtered views; the ledger itself is in History/Inventory."],
  },
  {
    id: "expenses",
    title: "Expenses",
    icon: "receipt_long",
    summary: "Shop overhead that hits Daily Cash-up.",
    body: [
      { heading: "What it does", text: "Log rent, utilities, courier etc. with Category, Amount, Payment method (Cash counts against the till in Daily Cash-up; Card/Bank are tracked but don't affect float), Note, Date." },
      { heading: "How to use", text: "1. Expenses → Add → Category/Amount/Method/Date → Save. 2. Summary by category appears in Reports for the same range." },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    icon: "settings",
    summary: "Pharmacy, users, printing, backups, and data tools — manager-only.",
    body: [
      { heading: "What it does", text: "Pharmacy (name, tax, MoMo, receipt footer), Logins (manager adds workers — manager sees all, workers see POS/Inventory-browse/Customers-browse/Support only, hidden not disabled), Printer (ESC/POS host:port), Backups (Save to flash drive, Restore — swaps DB + key, restarts), FDA Ghana catalog (count, Update — 30-60s, progress bar, yearly), Starting fresh? (Clear sample data — demo rows only, shows only when demo exists), Wipe all stock (dev only, one-tap empty for import testing, keeps users/settings/FDA), Appearance (dark mode), Loss prevention (Manager PIN for voids/returns/adjust −/receive/settle). FDA autocomplete has its own toggle (Enable FDA autocomplete in add forms)." },
      { heading: "How to use", text: "1. Set Pharmacy + tax + footer. 2. Logins → Add login (username/display name/temp password/role). Workers get worker, must change on first use. Reset PW / Deactivate from the same list. 3. Set Manager PIN (4-8 digits) — it gates the sensitive paths even for managers. 4. FDA catalog → Update once (needs internet), then works offline. Toggle off to hide FDA suggestions everywhere." },
    ],
    tips: ["Default manager is manager / manager (must change) unless you migrated a prior PIN.", "Demo data is filtered to 7,987 DRUG/DRUGS — Food/VPOM are excluded for chemical sellers."],
  },
  {
    id: "support",
    title: "Support",
    icon: "support_agent",
    summary: "Help (this) + contact.",
    body: [
      { heading: "What it does", text: "This Help tab (searchable per-section manual) plus Contact (describe what you were doing / what you expected → Send via Email — your mail app opens with pharmacy, staff, version, device id, date pre-filled, attach a screenshot there)." },
      { heading: "How to use", text: "1. Find your task above (search this page). 2. If stuck, flip to Contact, fill the two boxes, and Send via Email." },
    ],
  },
];

export function HelpDocs() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return DOCS;
    return DOCS.filter(
      (d) =>
        d.title.toLowerCase().includes(s) ||
        d.summary.toLowerCase().includes(s) ||
        d.body.some((b) => b.heading.toLowerCase().includes(s) || b.text.toLowerCase().includes(s)),
    );
  }, [q]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">search</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search help — e.g. return, FDA, requisition, void"
          className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest pl-8 pr-3 text-body-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {filtered.length === 0 && <p className="py-6 text-center text-body-sm text-on-surface-variant">No matches</p>}
        {filtered.map((s) => {
          const isOpen = open[s.id] ?? true;
          return (
            <div key={s.id} className="overflow-hidden rounded-xl border border-outline-variant bg-surface">
              <button
                onClick={() => setOpen((m) => ({ ...m, [s.id]: !isOpen }))}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-[18px] text-primary">{s.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-body-md font-semibold text-on-surface">{s.title}</p>
                  <p className="truncate text-body-sm text-on-surface-variant">{s.summary}</p>
                </div>
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant">{isOpen ? "expand_less" : "expand_more"}</span>
              </button>
              {isOpen && (
                <div className="border-t border-outline-variant/50 bg-surface-container-lowest px-4 py-3">
                  {s.body.map((b) => (
                    <div key={b.heading} className="mb-3 last:mb-0">
                      <h4 className="text-label-md font-label-md font-bold text-on-surface">{b.heading}</h4>
                      <p className="mt-1 whitespace-pre-line text-body-sm leading-relaxed text-on-surface-variant">{b.text}</p>
                    </div>
                  ))}
                  {s.tips && (
                    <div className="mt-3 rounded border border-primary/20 bg-primary/5 px-3 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Tips</p>
                      <ul className="mt-1 list-inside list-disc text-body-sm text-on-surface-variant">
                        {s.tips.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
