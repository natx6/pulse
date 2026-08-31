import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import {
  addSupplier,
  loadSuppliers,
  savePurchase,
  updatePurchase,
  type Purchase,
  type PurchaseItem,
  type Supplier,
} from "../db";
import { netUnitCost, lineTotal, profitMarginPct, orderTotal, round2 } from "../lib/price";
import { fmtMoney } from "../lib/money";
import { beep } from "../lib/audio";
import { Tip } from "./Tip";
import { DateField } from "./DateField";

interface Line {
  key: string;
  product_id: number;
  product_name: string;
  unit_type: string;
  quantity: string;
  unit_cost_raw: string;
  discount_percent: string;
  unit_selling_price: string;
  batch_no: string;
  expiry_date: string;
}

const UNIT_TYPES = [
  "Pack", "Box", "Strip", "Bottle", "Sachet",
  "Tube", "Vial", "Ampoule", "Blister", "Container",
  "Carton", "Case", "Pair", "Each", "Roll",
  "Pcs", "Set", "Kit", "Bag", "Jar",
  "Can", "Pouch", "Dragee", "Tablet", "Capsule",
  "Syrup", "Drops", "Inhaler", "Cream", "Ointment",
  "Solution", "Suspension", "Powder", "Granules",
  "Suppository", "Patch", "Ring", "Sponge",
  "Pen", "Spray", "Gel", "Lotion",
] as const;
const PAY_TERMS = ["Cash", "Credit", "30 Days", "60 Days"] as const;

/** Map a product's free-text unit (e.g. "strip (6 tabs)") to a dropdown preset. */
function inferUnit(unit: string | null): string {
  const u = (unit ?? "").toLowerCase();
  for (const t of UNIT_TYPES) if (u.includes(t.toLowerCase())) return t;
  return "Pack";
}

function newLine(p: { id: number; name: string; unit: string | null; cost_price: number; selling_price: number; expiry_date: string | null }): Line {
  return {
    key: crypto.randomUUID(),
    product_id: p.id,
    product_name: p.name,
    unit_type: inferUnit(p.unit),
    quantity: "1",
    unit_cost_raw: p.cost_price > 0 ? String(p.cost_price) : "",
    discount_percent: "0",
    unit_selling_price: p.selling_price > 0 ? String(p.selling_price) : "",
    batch_no: "",
    expiry_date: p.expiry_date ?? "",
  };
}

export function PurchaseModal({
  onClose,
  onSaved,
  edit,
}: {
  onClose(): void;
  onSaved(r: { id: string; total: number; items: number; received: boolean }): Promise<void>;
  edit?: { p: Purchase; items: PurchaseItem[] } | null;
}) {
  const editP = edit?.p ?? null;
  const products = useStore((s) => s.products);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<string>(
    editP?.supplier_id ? String(editP.supplier_id) : "",
  );
  const [newSupOpen, setNewSupOpen] = useState(false);
  const [supName, setSupName] = useState("");
  const [supPhone, setSupPhone] = useState("");
  const [supLocation, setSupLocation] = useState("");

  const [refNo, setRefNo] = useState(editP?.reference_no ?? "");
  const [date, setDate] = useState(
    editP?.purchase_date ?? new Date().toISOString().slice(0, 10),
  );
  const [payTerm, setPayTerm] = useState<string>(editP?.pay_term ?? "Cash");
  const [status, setStatus] = useState<string>(editP?.status ?? "Received");

  const [discountType, setDiscountType] = useState<string>(editP?.discount_type ?? "None");
  const [discountAmount, setDiscountAmount] = useState(
    editP && editP.discount_type !== "None" ? String(editP.discount_amount) : "",
  );

  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    (edit?.items ?? []).map((it) => ({
      key: crypto.randomUUID(),
      product_id: it.product_id,
      product_name: it.product_name,
      unit_type: it.unit_type,
      quantity: String(it.quantity),
      unit_cost_raw: it.unit_cost_raw > 0 ? String(it.unit_cost_raw) : "",
      discount_percent: it.discount_percent > 0 ? String(it.discount_percent) : "0",
      unit_selling_price: it.unit_selling_price > 0 ? String(it.unit_selling_price) : "",
      batch_no: it.batch_no ?? "",
      expiry_date: it.expiry_date,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [supErr, setSupErr] = useState("");
  const [supBusy, setSupBusy] = useState(false);

  useEffect(() => {
    void loadSuppliers().then(setSuppliers);
  }, []);

  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(s) ||
          (p.barcode ?? "").toLowerCase().includes(s) ||
          (p.sku ?? "").toLowerCase().includes(s),
      )
      .slice(0, 8);
  }, [products, search]);

  /** Items at or below their reorder level (including out of stock). */
  const lowItems = useMemo(
    () => products.filter((p) => p.stock_qty <= p.reorder_level),
    [products],
  );

  const addProduct = (p: (typeof products)[number]) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product_id === p.id);
      if (i >= 0) {
        const copy = [...ls];
        copy[i] = { ...copy[i], quantity: String((Number(copy[i].quantity) || 0) + 1) };
        return copy;
      }
      return [...ls, newLine(p)];
    });
  };

  const updLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  // Exact barcode/SKU match auto-adds the row (continuous scanning).
  useEffect(() => {
    const s = search.trim();
    if (!s) return;
    const p = products.find(
      (x) => x.barcode === s || (x.sku ?? "").toLowerCase() === s.toLowerCase(),
    );
    if (p) {
      addProduct(p);
      setSearch("");
      beep(true);
    }
  }, [search, products]);

  const addLowStock = () => {
    setLines((ls) => {
      const existing = new Set(ls.map((l) => l.product_id));
      const toAdd = lowItems.filter((p) => !existing.has(p.id)).map(newLine);
      return [...ls, ...toAdd];
    });
    setSearch("");
  };

  const onSearchEnter = () => {
    const s = search.trim();
    if (!s) return;
    const exact = products.find(
      (p) => p.barcode === s || (p.sku ?? "").toLowerCase() === s.toLowerCase(),
    );
    if (exact) {
      addProduct(exact);
      setSearch("");
      beep(true);
      return;
    }
    const m = matches[0];
    if (m) {
      addProduct(m);
      setSearch("");
      beep(true);
    }
  };

  /** Parsed + computed per line (strings kept in state so inputs never jump). */
  const computed = useMemo(
    () =>
      lines.map((l) => {
        const qty = Number(l.quantity) || 0;
        const raw = Number(l.unit_cost_raw) || 0;
        const disc = Number(l.discount_percent) || 0;
        const sp = Number(l.unit_selling_price) || 0;
        const net = netUnitCost(raw, disc);
        return { ...l, qty, net, total: lineTotal(qty, net), margin: profitMarginPct(sp, net) };
      }),
    [lines],
  );

  const subtotal = useMemo(() => computed.reduce((s, l) => s + l.total, 0), [computed]);
  const netTotal = useMemo(
    () =>
      orderTotal(
        computed.map((l) => ({ line_total: l.total })),
        discountType,
        Number(discountAmount) || 0,
      ),
    [computed, discountType, discountAmount],
  );
  const unitCount = useMemo(() => computed.reduce((s, l) => s + l.qty, 0), [computed]);
  const missingExpiry = useMemo(
    () => computed.filter((l) => !l.expiry_date).length,
    [computed],
  );

  const addSupplierNow = async () => {
    if (!supName.trim()) {
      setSupErr("Supplier name is required.");
      return;
    }
    setSupBusy(true);
    setSupErr("");
    try {
      const id = await addSupplier(supName, supPhone, supLocation);
      setSuppliers(await loadSuppliers());
      setSupplierId(String(id));
      setNewSupOpen(false);
      setSupName("");
      setSupPhone("");
      setSupLocation("");
    } catch (e) {
      setSupErr(String(e).replace(/^Error: /, ""));
    } finally {
      setSupBusy(false);
    }
  };

  const save = async () => {
    if (computed.length === 0) {
      setErr("Add at least one product.");
      return;
    }
    if (computed.some((l) => l.qty <= 0)) {
      setErr("Every line needs a quantity above zero.");
      return;
    }
    if (discountType === "Percentage" && Number(discountAmount) > 100) {
      setErr("Percentage discount can't exceed 100%.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      // supplier_name keeps the recorded name when editing an order with no
      // supplier id (legacy backfilled orders); new orders resolve from the id.
      const common = {
        supplier_id: supplierId ? Number(supplierId) : null,
        supplier_name: supplierId ? null : (editP?.supplier_name ?? null),
        reference_no: refNo || null,
        purchase_date: date,
        pay_term: payTerm,
        status,
        discount_type: discountType,
        discount_amount: Number(discountAmount) || 0,
        lines: computed.map((l) => ({
          product_id: l.product_id,
          product_name: l.product_name,
          unit_type: l.unit_type,
          quantity: l.qty,
          unit_cost_raw: l.unit_cost_raw ? Number(l.unit_cost_raw) : 0,
          discount_percent: l.discount_percent ? Number(l.discount_percent) : 0,
          unit_selling_price: l.unit_selling_price ? Number(l.unit_selling_price) : 0,
          batch_no: l.batch_no || null,
          expiry_date: l.expiry_date,
        })),
      };
      let r: { id: string; total: number; items: number; received: boolean };
      if (editP) {
        const u = await updatePurchase({ purchase_id: editP.id, ...common });
        r = { ...u, received: false };
      } else {
        r = await savePurchase(common);
      }
      beep(true);
      await onSaved(r);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "h-8 w-full rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const numCls =
    "h-7 w-full rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none";

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        // The search box below handles its own Escape (clear search) and
        // stops propagation while there's text to clear; once it's empty,
        // Escape isn't intercepted there and reaches this handler instead.
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">
              {editP ? "Edit Purchase" : "New Purchase"}
            </h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              {editP
                ? "Fix the order before any stock is received — totals are recomputed."
                : "Record a supplier invoice. Save as Received to add the goods to stock now."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* Header metadata */}
          <div className="mb-4 grid grid-cols-12 gap-3">
            <div className="col-span-5">
              <label className="mb-1 block text-label-md font-label-md text-on-surface">
                Supplier
              </label>
              <div className="flex gap-2">
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">— no supplier —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <Tip label="Add a new supplier" align="left">
                  <button
                    onClick={() => setNewSupOpen((o) => !o)}
                    className="h-8 shrink-0 rounded border border-outline px-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                  >
                    + New
                  </button>
                </Tip>
              </div>
              {newSupOpen && (
                <div className="mt-2 space-y-2 rounded border border-outline-variant bg-surface-container-low p-3">
                  <input
                    value={supName}
                    onChange={(e) => setSupName(e.target.value)}
                    placeholder="Supplier name"
                    className={inputCls}
                  />
                  <div className="flex gap-2">
                    <input
                      value={supPhone}
                      onChange={(e) => setSupPhone(e.target.value)}
                      placeholder="Phone (optional)"
                      className={inputCls}
                    />
                    <input
                      value={supLocation}
                      onChange={(e) => setSupLocation(e.target.value)}
                      placeholder="Location (optional)"
                      className={inputCls}
                    />
                  </div>
                  {supErr && <p className="text-body-sm text-error">{supErr}</p>}
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setNewSupOpen(false)}
                      className="rounded border border-outline px-3 py-1 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void addSupplierNow()}
                      disabled={supBusy}
                      className="rounded bg-primary px-4 py-1 text-label-md font-label-md text-on-primary hover:bg-on-primary-fixed-variant disabled:opacity-50"
                    >
                      {supBusy ? "Adding…" : "Add supplier"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="col-span-7 grid grid-cols-4 gap-3">
              <label className="block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Reference No.
                </span>
                <input
                  value={refNo}
                  onChange={(e) => setRefNo(e.target.value)}
                  placeholder="Invoice / waybill #"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Date
                </span>
                <DateField
                  value={date}
                  onChange={setDate}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Pay term
                </span>
                <select value={payTerm} onChange={(e) => setPayTerm(e.target.value)} className={inputCls}>
                  {PAY_TERMS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Status
                </span>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                  {editP ? (
                    <>
                      <option value="Ordered">Ordered</option>
                      <option value="Draft">Draft</option>
                    </>
                  ) : (
                    <>
                      <option value="Received">Received</option>
                      <option value="Ordered">Ordered</option>
                      <option value="Draft">Draft</option>
                    </>
                  )}
                </select>
              </label>
            </div>
          </div>

          {/* Add products */}
          <div className="mb-3 flex items-center gap-3">
            <label className="block flex-1">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Add products
              </span>
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSearchEnter();
                  }
                  if (e.key === "Escape" && search) {
                    // There's text to clear — handle it here and stop, so
                    // this Escape press clears the search instead of also
                    // closing the whole modal via the wrapper's handler.
                    e.stopPropagation();
                    setSearch("");
                  }
                }}
                placeholder="Scan barcode, type SKU or name…"
                className={inputCls}
              />
            </label>
            {lowItems.length > 0 && (
              <button
                onClick={addLowStock}
                className="mt-4 flex items-center gap-2 rounded border border-warn/60 bg-warn-subtle px-3 py-1.5 text-label-md font-label-md text-warn transition-colors hover:bg-warn-muted"
                title="Add every item at or below its reorder level — then type how many you need"
              >
                <span className="material-symbols-outlined text-[16px]">inventory_2</span>
                Add low &amp; out-of-stock ({lowItems.length})
              </button>
            )}
          </div>
          {search.trim() && matches.length === 0 && (
            <p className="mb-2 text-body-sm text-on-surface-variant">
              No matches — Enter to search the counter, or add a new product in Inventory.
            </p>
          )}
          {search.trim() && matches.length > 0 && (
            <div className="mb-3 overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-sm">
              {matches.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    addProduct(p);
                    setSearch("");
                    beep(true);
                  }}
                  className="flex w-full items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 text-left last:border-0 hover:bg-surface-container-low"
                >
                  <span className="min-w-0 truncate text-body-sm text-on-surface">
                    {p.name}
                    {p.unit ? <span className="ml-1 text-on-surface-variant">({p.unit})</span> : null}
                  </span>
                  <span className="ml-2 shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                    {p.barcode ?? p.sku ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Lines table */}
          {lines.length > 0 && (
            <div className="overflow-auto rounded-lg border border-outline-variant">
              <table className="w-full min-w-[1150px] border-collapse text-left">
                <thead>
                  <tr className="bg-surface-container-low text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
                    <th className="px-2 py-1.5">Product</th>
                    <th className="w-24 px-1 py-1.5">Sell as</th>
                    <th className="w-16 px-1 py-1.5 text-right">Qty</th>
                    <th className="w-20 px-1 py-1.5 text-right">Unit cost</th>
                    <th className="w-14 px-1 py-1.5 text-right">Disc %</th>
                    <th className="w-20 px-1 py-1.5 text-right">Net cost</th>
                    <th className="w-20 px-1 py-1.5 text-right">Sell price</th>
                    <th className="w-16 px-1 py-1.5 text-right">Margin</th>
                    <th className="w-24 px-1 py-1.5 text-right">Line total</th>
                    <th className="w-32 px-1 py-1.5">Expiry</th>
                    <th className="w-32 px-1 py-1.5">Batch no</th>
                    <th className="sticky right-0 w-8 bg-surface-container-low px-1 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {computed.map((l) => (
                    <tr key={l.key} className="border-t border-outline-variant/50 hover:bg-surface-container-lowest">
                      <td className="px-2 py-1">
                        <p className="truncate text-body-sm font-semibold text-on-surface" title={l.product_name}>
                          {l.product_name}
                        </p>
                      </td>
                      <td className="px-1 py-1">
                        <input
                          list="unit-types"
                          value={l.unit_type}
                          onChange={(e) => updLine(l.key, { unit_type: e.target.value })}
                          className="h-7 w-full rounded border border-outline-variant bg-surface-container-lowest px-1 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={l.quantity}
                          onChange={(e) => updLine(l.key, { quantity: e.target.value })}
                          title="Quantity"
                          className={numCls}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={l.unit_cost_raw}
                          onChange={(e) => updLine(l.key, { unit_cost_raw: e.target.value })}
                          placeholder="0.00"
                          title="Unit cost before discount"
                          className={numCls}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="any"
                          value={l.discount_percent}
                          onChange={(e) => updLine(l.key, { discount_percent: e.target.value })}
                          placeholder="0"
                          title="Line discount %"
                          className={numCls}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <span className="block text-right font-data-mono text-data-mono text-on-surface">
                          {fmtMoney(round2(l.net))}
                        </span>
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={l.unit_selling_price}
                          onChange={(e) => updLine(l.key, { unit_selling_price: e.target.value })}
                          placeholder="0.00"
                          title="Unit selling price"
                          className={numCls}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <span
                          className={`block text-right font-data-mono text-data-mono ${
                            l.margin === null
                              ? "text-on-surface-variant"
                              : l.margin < 0
                                ? "text-error"
                                : l.margin < 10
                                  ? "text-warn"
                                  : "text-primary"
                          }`}
                          title={l.margin === null ? "Set a selling price to see the margin" : "Profit margin on selling price"}
                        >
                          {l.margin === null ? "—" : `${l.margin.toFixed(1)}%`}
                        </span>
                      </td>
                      <td className="px-1 py-1">
                        <span className="block text-right font-data-mono text-data-mono font-bold text-on-surface">
                          {fmtMoney(round2(l.total))}
                        </span>
                      </td>
                      <td className="px-1 py-1">
                        <DateField
                          value={l.expiry_date}
                          onChange={(v) => updLine(l.key, { expiry_date: v })}
                          className="h-7"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="text"
                          value={l.batch_no}
                          onChange={(e) => updLine(l.key, { batch_no: e.target.value })}
                          placeholder="Batch #"
                          className="h-7 w-full rounded border border-outline-variant bg-surface-container-lowest px-1 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                        />
                      </td>
                      <td className="sticky right-0 bg-surface px-1 py-1">
                        <button
                          onClick={() => removeLine(l.key)}
                          title="Remove line"
                          aria-label={`Remove ${l.product_name}`}
                          className="flex h-6 w-6 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant transition-colors hover:border-error hover:bg-error-container hover:text-error"
                        >
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <datalist id="unit-types">
            {UNIT_TYPES.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>

          {missingExpiry > 0 && (
            <p className="mt-2 text-body-sm text-warn">
              {missingExpiry} line{missingExpiry === 1 ? "" : "s"} ha{missingExpiry === 1 ? "s" : "ve"} no
              expiry date — you can still save.
            </p>
          )}
          {err && <p className="mt-2 text-body-sm text-error">{err}</p>}
        </div>

        {/* Footer: discount + totals + actions */}
        <div className="border-t border-outline-variant bg-surface-container px-6 py-4">
          <div className="flex items-end justify-between gap-6">
            <div className="flex items-end gap-2">
              <label className="block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Order discount
                </span>
                <select
                  value={discountType}
                  onChange={(e) => {
                    setDiscountType(e.target.value);
                    if (e.target.value === "None") setDiscountAmount("");
                  }}
                  className="h-8 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                >
                  <option value="None">None</option>
                  <option value="Fixed">Fixed (GH₵)</option>
                  <option value="Percentage">Percentage (%)</option>
                </select>
              </label>
              <input
                type="number"
                min={0}
                max={discountType === "Percentage" ? 100 : undefined}
                step="any"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
                disabled={discountType === "None"}
                placeholder={discountType === "Percentage" ? "0%" : "0.00"}
                className="h-8 w-24 rounded border border-outline-variant bg-surface-container-lowest px-2 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
              />
            </div>
            <div className="text-right">
              <p className="text-body-sm text-on-surface-variant">
                {computed.length} item{computed.length === 1 ? "" : "s"} · {unitCount} unit
                {unitCount === 1 ? "" : "s"}
              </p>
              <p className="text-body-sm text-on-surface-variant">
                Subtotal {fmtMoney(round2(subtotal))}
                {discountType === "Fixed" && Number(discountAmount) > 0
                  ? ` − ${fmtMoney(Number(discountAmount))}`
                  : discountType === "Percentage" && Number(discountAmount) > 0
                    ? ` − ${Number(discountAmount)}%`
                    : ""}
              </p>
              <p className="text-headline-md font-headline-md font-bold text-primary">
                Net total {fmtMoney(round2(netTotal))}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Cancel
              </button>
              <Tip
                label={
                  status === "Received"
                    ? "One transaction: record the invoice and add every line to stock"
                    : "Record the order — stock lands when you receive it"
                }
              >
                <button
                  onClick={() => void save()}
                  disabled={busy || computed.length === 0}
                  className="flex items-center gap-2 rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {status === "Received" ? "inventory_2" : "save"}
                  </span>
                  {busy
                    ? "Saving…"
                    : status === "Received"
                      ? "Save & Add to Stock"
                      : status === "Ordered"
                        ? "Save Order"
                        : "Save Draft"}
                </button>
              </Tip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
