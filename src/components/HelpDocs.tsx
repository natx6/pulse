import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";

type DocSection = {
  id: string;
  title: string;
  icon: string;
  summary: string;
  when: string;
  buttons: { label: string; does: string }[];
  mixup?: { vs: string; pick: string }[];
};

const DOCS: DocSection[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    icon: "space_dashboard",
    summary: "Where you stand right now — today's money and what needs attention.",
    when: "You open Pulse. First thing you see every morning.",
    buttons: [
      { label: "Sales today / Profit / In till", does: "Today's takings, your profit, and what should be in the drawer (opening float + cash in − refunds − cash expenses)." },
      { label: "Low stock / Expiring / Expired pills", does: "Tap a name to jump to Inventory and reorder. Critical = stock is 0." },
      { label: "Open purchases", does: "Requisitions you ordered but haven't received yet." },
      { label: "Cost of stock / Retail", does: "Cost is GH₵0 until you import buying prices; Retail is what the shelf is worth at selling price." },
    ],
  },
  {
    id: "pos",
    title: "POS (Counter)",
    icon: "point_of_sale",
    summary: "Sell to a customer.",
    when: "Someone is standing in front of you.",
    buttons: [
      { label: "Search box", does: "Type a name, barcode, or supplier — also finds generics (diclo) and brands (roy) once FDA products are saved. Ctrl+K focuses it." },
      { label: "Barcode Scan", does: "Focuses the search so the scanner types straight in. Unknown code offers Add Manual Item." },
      { label: "Product tile", does: "Tap to add one. Tap Add pack to add a whole carton at once (pack_size units)." },
      { label: "+ / − on a cart line", does: "Change quantity. Never goes past what's on the shelf." },
      { label: "New Prescription", does: "Hold the current order and clear the counter for a new customer." },
      { label: "Hold (F8)", does: "Park the order and bring it back later." },
      { label: "Patient (Enter)", does: "Attach the sale to a customer — needed for credit and discount tiers." },
      { label: "Add Manual Item", does: "Create a product that isn't in the catalog — Name + Price, with FDA suggestions when on. Goes to cart AND inventory (1 unit, no batch)." },
      { label: "Cash / Card / Mobile Money / Credit", does: "How they pay. Cash asks for tendered and shows change. Credit books it to the customer (settle later in Customers)." },
      { label: "Complete Sale", does: "Finishes the sale, prints if a printer is set, decrements stock. F9/F10/F11 switch pay method." },
    ],
    mixup: [
      { vs: "Hold vs Cancel", pick: "Hold keeps the cart for later; clearing (× on each line or a fresh prescription) throws it away." },
    ],
  },
  {
    id: "history",
    title: "History",
    icon: "history",
    summary: "Find an old sale — reprint, void, or refund.",
    when: "A customer comes back days later.",
    buttons: [
      { label: "Date / patient / receipt filters", does: "Narrow to the sale you want." },
      { label: "Reprint", does: "Prints the exact receipt again (same discount/tax as the sale)." },
      { label: "Void (today's last sale only)", does: "Deletes the most recent sale of today entirely and puts stock back. Needs manager PIN if set. Anything older must be Returned." },
      { label: "Return", does: "Refund part or all of any sale, any day. Pick Qty per product (capped at sold − alreadyReturned) → Reason → Manager PIN if set → Refund & restock. Sale stays in the books; stock goes back to the right batch." },
    ],
    mixup: [
      { vs: "Void vs Return", pick: "Void = erase today's mistake. Return = customer brings goods back days later. Both put stock back." },
    ],
  },
  {
    id: "customers",
    title: "Customers",
    icon: "groups",
    summary: "Find a person — see visits, history, and what they owe.",
    when: "Someone on credit returns, or you want their discount/history.",
    buttons: [
      { label: "Search", does: "By name or phone. Customers are auto-created on sale — no pre-registering." },
      { label: "A customer row", does: "Opens visits, Total visits, Last visit, per-customer Discount %, Last 10 sales (tap to reprint), and Outstanding credit." },
      { label: "Settle", does: "Record a payment against credit — amount + Cash/MoMo/Bank/Cheque → Manager PIN if set → Record. Shortfalls stay as balance." },
      { label: "Import customers", does: "Bulk-load old customers + opening balances (carry-over credit) from Excel." },
    ],
  },
  {
    id: "inventory",
    title: "Inventory (Your shelf)",
    icon: "inventory_2",
    summary: "Everything on the shelf — stock, batches, reorder.",
    when: "You want to see, add, or fix stock.",
    buttons: [
      { label: "Search (Ctrl+K) / Sort headers", does: "Find by name, barcode, supplier. Sort by any column. Shows 100/page with Prev/Next." },
      { label: "An item row (chevron)", does: "Expands its batches — nearest expiry first (what sells first). Red exp = expired." },
      { label: "Status pill", does: "In Stock / Reorder Soon (≤ min) / Critical (0). Min is the reorder level." },
      { label: "Add Product", does: "Hand-type one new item. Opens as 3 fields — Name (FDA suggestion after 2 letters), Selling*, Stock qty* — plus More for Barcode/Category/Supplier/Cost/Reorder/Pack/Batch/Expiry. Category and Supplier are dropdowns of yours (+ New). Pack = how many sell units per carton (1 = single). Saves product + one batch." },
      { label: "Import Stock", does: "Bulk-load your old Excel at once (≤5,000 rows). Auto-matches Name of Medication, Sale Price (Base Price), Expiry Date, Quantity, Batch Number, Brand Name, etc. Shows all rows as a table with an FDA column (Use FDA, Apply to all rows). Two-tap Import — backup taken first, one transaction." },
      { label: "Receive Stock (F2)", does: "A delivery just arrived. Log Supplier + Qty + Unit cost + Batch + Expiry per product — adds to batches with real batch/expiry." },
      { label: "Stock take", does: "Audit: count what's actually on the shelf for everything, enter counts, Commit — differences become corrections + one audit row." },
      { label: "tune (row)", does: "Quick fix for one product — quantity ± (reducing needs Manager PIN if set), Reason, Reorder, Pack." },
      { label: "Print Label", does: "Print a scannable Code39 shelf label." },
      { label: "Archive", does: "Hide a discontinued item from POS/Inventory (two taps). Archived toggle brings them back." },
    ],
    mixup: [
      { vs: "Import vs Add Product", pick: "Import = 100s of items at once from Excel. Add Product = one by hand from the shelf." },
      { vs: "Receive vs Stock take", pick: "Receive = truck delivered, log what came. Stock take = you doubt the shelf, count everything and fix." },
    ],
  },
  {
    id: "restock",
    title: "Requisitions",
    icon: "shopping_cart",
    summary: "Order from your supplier, receive it, and know what you owe.",
    when: "Stock is low and you need to order.",
    buttons: [
      { label: "New Purchase", does: "Pick Supplier (or + New) → Reference No. (invoice/waybill) → Date → Pay term → add products (search or Add low & out-of-stock). Per line: Sell as (Pack/Bottle/Inhaler — what you sell), Qty, Unit cost, Disc %, Net cost, Sell price, Margin, Line total, Expiry, Batch no. Order discount at the bottom." },
      { label: "Add low & out-of-stock", does: "One click adds everything at/below its reorder level — then type how many you need." },
      { label: "Save as Ordered / Draft", does: "Keeps the order without touching stock (nothing received yet)." },
      { label: "Save & Add to Stock (Received)", does: "Receives now — adds all lines to stock + batches and tracks cost for margin." },
      { label: "An existing order → Receive", does: "When the truck arrives later, enter actual received qtys/batches against the same order." },
      { label: "Pay (supplier balance)", does: "Record what you paid the supplier; balance = purchases − payments + opening." },
    ],
    mixup: [
      { vs: "Sell as vs Pack size", pick: "Sell as is the name of the unit you sell (Inhaler). Pack size (set in Add Product) is the carton shortcut for POS." },
    ],
  },
  {
    id: "reports",
    title: "Reports",
    icon: "bar_chart",
    summary: "See what you made and spent.",
    when: "End of day / auditor / accountant.",
    buttons: [
      { label: "Today / Yesterday / 7 / 30 / Custom", does: "Pick the range. Operator and Method filters narrow further." },
      { label: "Sales / Profit / Margin / VAT / Discount", does: "The KPIs for the range. VAT uses your tax rate; discount shows patient tiers." },
      { label: "Controlled-drug register", does: "The dangerous-drugs book — Dispensed/Received/Returned with prescriber fields. Print for inspectors." },
      { label: "Supplier Balances", does: "What you owe each supplier (opening + purchases − payments). Import suppliers with opening balances here." },
      { label: "Audit Trail", does: "Every action in the range, newest first — sales, returns, voids, adjustments, purchases, payments, imports, expenses, logins' changes. Included in Export CSV." },
      { label: "Export CSV", does: "Writes the whole report (choose where to save) for the accountant or auditor." },
    ],
  },
  {
    id: "expenses",
    title: "Expenses",
    icon: "receipt_long",
    summary: "What you spent — rent, light, courier.",
    when: "Money leaves the shop for anything that isn't stock.",
    buttons: [
      { label: "Add", does: "Category + Amount + Payment method + Note + Date. Cash expenses count against the till in Daily Cash-up; Card/Bank are tracked but don't touch the float." },
      { label: "Summary (in Reports)", does: "Same range — expenses by category alongside sales." },
    ],
  },
  {
    id: "settings",
    title: "Settings (Manager)",
    icon: "settings",
    summary: "Your shop, users, printer, backup, and data tools.",
    when: "Setup, staff changes, printing, backups, yearly refresh.",
    buttons: [
      { label: "Pharmacy", does: "Name, tax %, MoMo number, receipt footer — appears on receipts." },
      { label: "Logins", does: "Manager adds workers (Username / Display name / Temp password / Role). Workers see POS, Inventory (browse), Customers (browse), Support only — hidden, not disabled. Reset PW / Deactivate anyone but the last active manager." },
      { label: "Printer", does: "ESC/POS host:port (default 9100). Receipts print straight to it, no dialog." },
      { label: "Backups", does: "Save to flash drive (copies pulse.key too — keep them together). Restore swaps the DB and restarts. Auto-backups every 10th sale, on exit, and from Reports; newest 20 kept." },
      { label: "FDA Ghana catalog", does: "Shows 7,987 DRUG/DRUGS count. Update FDA catalog pulls the yearly register (30-60s, needs internet) with a progress bar — then works offline. Enable FDA autocomplete toggle hides suggestions everywhere (Quick Add, Add Product, Import)." },
      { label: "Starting fresh?", does: "Clear sample data — demo rows only (DMO-, Demo Wholesale, Ama Mensah). Only shows when demo data exists (dev). Wipe all stock (dev only) empties everything for import testing — keeps users/settings/FDA." },
      { label: "Appearance", does: "Dark mode toggle." },
      { label: "Loss prevention (Manager PIN)", does: "4-8 digits. Gates voids, returns, stock reductions, receiving, and credit settlement. Separate from the manager login password. Default manager is manager / manager (must change) unless you migrated a prior PIN." },
    ],
  },
  {
    id: "support",
    title: "Support",
    icon: "support_agent",
    summary: "This help (search it) + the tour + how to reach us.",
    when: "You're stuck or want to re-learn.",
    buttons: [
      { label: "Help (search here)", does: "This page — per-tab, button-by-button. Try return, FDA, requisition, void." },
      { label: "Take a product tour", does: "Replays the spotlight tour (workers see only their tabs)." },
      { label: "Contact", does: "What you were doing + what you expected → Send via Email. Your mail app opens with pharmacy, staff, version, device, date pre-filled — attach a screenshot there." },
    ],
  },
];

export function HelpDocs() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const currentUser = useStore((s) => s.currentUser);
  // Workers only see help for tabs they can open; manager sees all. Keep it
  // in a memo so search + role both filter, and hide manager-only buttons.
  const roleFiltered = useMemo(() => {
    const isWorker = currentUser?.role === "worker";
    if (!isWorker) return DOCS;
    const hideSections = new Set(["restock", "reports", "settings"]);
    const hideButtons: Record<string, Set<string>> = {
      history: new Set(["Void (today's last sale only)", "Return"]),
      customers: new Set(["Settle", "Import customers"]),
      inventory: new Set(["Add Product", "Import Stock", "Receive Stock (F2)", "Stock take", "tune (row)", "Archive"]),
      support: new Set(["Logins"]),
    };
    return DOCS.filter((d) => !hideSections.has(d.id)).map((d) => {
      const bad = hideButtons[d.id];
      if (!bad) return d;
      return { ...d, buttons: d.buttons.filter((b) => !bad.has(b.label)) };
    });
  }, [currentUser]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return roleFiltered;
    return roleFiltered.filter(
      (d) =>
        d.title.toLowerCase().includes(s) ||
        d.summary.toLowerCase().includes(s) ||
        d.when.toLowerCase().includes(s) ||
        d.buttons.some((b) => b.label.toLowerCase().includes(s) || b.does.toLowerCase().includes(s)),
    );
  }, [q, roleFiltered]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">search</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search help — e.g. Add Product, return, requisition, FDA"
          className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest pl-8 pr-3 text-body-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {filtered.length === 0 && <p className="py-6 text-center text-body-sm text-on-surface-variant">No matches — try return, Add Product, FDA, or void</p>}
        {filtered.map((s) => {
          // Collapsed by default; auto-expand everything while searching so
          // matches are readable without tapping each section open.
          const isOpen = q.trim() ? true : (open[s.id] ?? false);
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
                  <p className="mb-3 rounded bg-primary/5 px-3 py-2 text-body-sm text-on-surface">
                    <span className="font-bold">When:</span> {s.when}
                  </p>
                  <div className="space-y-2">
                    {s.buttons.map((b) => (
                      <div key={b.label} className="flex gap-3 rounded border border-outline-variant/50 bg-surface px-3 py-2">
                        <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary self-start">{b.label}</span>
                        <p className="text-body-sm leading-relaxed text-on-surface-variant">{b.does}</p>
                      </div>
                    ))}
                  </div>
                  {s.mixup && (
                    <div className="mt-3 rounded border border-warn/30 bg-warn/5 px-3 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-warn">Easy to confuse</p>
                      <ul className="mt-1 space-y-1">
                        {s.mixup.map((m) => (
                          <li key={m.vs} className="text-body-sm text-on-surface-variant">
                            <span className="font-bold text-on-surface">{m.vs}:</span> {m.pick}
                          </li>
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
