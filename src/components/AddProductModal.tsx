import { useEffect, useState } from "react";
import { createProduct, loadSuppliers, searchFdaDrugs, type FdaDrug } from "../db";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";
import type { Supplier } from "../db";
import { DateField } from "./DateField";

interface Props {
  onClose(): void;
}

export function AddProductModal({ onClose }: Props) {
  const refreshProducts = useStore((s) => s.refreshProducts);
  const fdaAutocomplete = useStore((s) => s.fdaAutocomplete);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  const [strength, setStrength] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [stockQty, setStockQty] = useState("");
  const [reorderLevel, setReorderLevel] = useState("10");
  const [packSize, setPackSize] = useState("1");
  const [batchNo, setBatchNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [genericName, setGenericName] = useState("");
  const [activeIngredient, setActiveIngredient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fdaResults, setFdaResults] = useState<FdaDrug[]>([]);
  const [showFda, setShowFda] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierMode, setSupplierMode] = useState<"select" | "new">("select");
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryMode, setCategoryMode] = useState<"select" | "new">("select");

  useEffect(() => {
    loadSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
  }, []);
  useEffect(() => {
    import("../db").then(async (m) => {
      try {
        const d = await m.initDb();
        const rows = await d.select<{ category: string }[]>(
          "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category",
          [],
        );
        const existing = rows.map((r) => r.category).filter(Boolean);
        // Seed with common pharmacy classes if DB is still empty.
        const defaults = ["Analgesic", "Antibiotic", "Antimalarial", "Vitamins", "Supplements", "Cough & Cold", "Dermatology", "OTC", "Prescription"];
        const merged = Array.from(new Set([...existing, ...defaults])).sort();
        setCategories(merged);
      } catch {
        setCategories(["Analgesic", "Antibiotic", "Antimalarial", "Vitamins", "Supplements", "OTC"]);
      }
    });
  }, []);

  useEffect(() => {
    const q = name.trim();
    if (!fdaAutocomplete || q.length < 2) {
      setFdaResults([]);
      setShowFda(false);
      return;
    }
    const t = window.setTimeout(() => {
      searchFdaDrugs(q, 8)
        .then((r) => {
          setFdaResults(r);
          setShowFda(r.length > 0);
        })
        .catch(() => setFdaResults([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [name, fdaAutocomplete]);

  const submit = async () => {
    const nm = name.trim();
    if (!nm) {
      setError("Product name is required.");
      beep(false);
      return;
    }
    const cost = Number(costPrice) || 0;
    const sell = Number(sellingPrice) || 0;
    if (sell <= 0) {
      setError("Selling price must be above 0.");
      beep(false);
      return;
    }
    const qty = Math.max(0, Math.floor(Number(stockQty) || 0));
    const reorder = Math.max(0, Math.floor(Number(reorderLevel) || 10));
    const pack = Math.max(1, Math.floor(Number(packSize) || 1));
    setBusy(true);
    setError("");
    try {
      await createProduct({
        name: nm,
        barcode: barcode.trim() || null,
        category: category.trim() || null,
        supplier: supplier.trim() || null,
        strength: strength.trim() || null,
        generic_name: genericName.trim() || null,
        active_ingredient: activeIngredient.trim() || null,
        cost_price: cost,
        selling_price: sell,
        stock_qty: qty,
        reorder_level: reorder,
        pack_size: pack,
        batch_no: batchNo.trim() || null,
        expiry_date: expiryDate.trim() || null,
      });
      await refreshProducts();
      beep(true);
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-modal-open
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">Add Product</h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">Hand-enter stock — type 2 letters for FDA suggestions.</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 pb-20">
          <div className="grid grid-cols-1 gap-3">
            <label className="block">
              <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Name *</span>
              <div className="relative">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onFocus={() => fdaResults.length > 0 && setShowFda(true)}
                  onBlur={() => window.setTimeout(() => setShowFda(false), 150)}
                  placeholder="e.g. Paracetamol 500mg"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {showFda && fdaResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto rounded border border-outline-variant bg-surface shadow-lg">
                    <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                      FDA Ghana — {fdaResults.length} match{fdaResults.length === 1 ? "" : "es"}
                    </p>
                    {fdaResults.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const clean = d.product_name.replace(/\s*\(.*\)\s*$/, "").trim() || d.product_name;
                        setName(clean);
                        if (d.strength) setStrength(d.strength);
                        if (d.generic_name) setGenericName(d.generic_name);
                        if (d.active_ingredient) setActiveIngredient(d.active_ingredient);
                        // Auto-fill Category from FDA sub-category/classification where it looks like
                        // a shelf class (Antibiotic etc.), otherwise leave the dropdown for the user.
                        const fdaCat = (d.product_sub_category || d.product_category || "").trim();
                        if (fdaCat && fdaCat.toLowerCase() !== "drug" && fdaCat.toLowerCase() !== "drugs") {
                          setCategory(fdaCat);
                          setCategoryMode("select");
                          setCategories((prev) => (prev.includes(fdaCat) ? prev : [...prev, fdaCat].sort()));
                        }
                        // Do not auto-fill supplier from FDA — supplier is the local wholesaler
                        // you requisition from (Kinapharma etc.), not the FDA applicant/manufacturer.
                        setShowFda(false);
                      }}
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-container-low"
                    >
                      <span className="text-body-sm font-semibold text-on-surface">{d.product_name}</span>
                      <span className="text-[11px] text-on-surface-variant">
                        {[d.generic_name, d.strength, d.dosage_form].filter(Boolean).join(" · ") || d.product_category || ""}
                      </span>
                    </button>
                    ))}
                  </div>
                )}
              </div>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Barcode</span>
                <input
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Optional"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Category</span>
                {categoryMode === "select" ? (
                  <select
                    value={category}
                    onChange={(e) => {
                      if (e.target.value === "__new__") {
                        setCategoryMode("new");
                        setCategory("");
                      } else {
                        setCategory(e.target.value);
                      }
                    }}
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                  >
                    <option value="">— Select category —</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    <option value="__new__">+ New category…</option>
                  </select>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder="e.g. Analgesic"
                      className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setCategoryMode("select");
                        setCategory("");
                      }}
                      className="shrink-0 rounded border border-outline-variant px-2 text-label-md text-on-surface hover:bg-surface-variant"
                    >
                      Select
                    </button>
                  </div>
                )}
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Strength</span>
                <input
                  value={strength}
                  onChange={(e) => setStrength(e.target.value)}
                  placeholder="e.g. 500mg"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Supplier — you requisition from</span>
                {supplierMode === "select" ? (
                  <select
                    value={supplier}
                    onChange={(e) => {
                      if (e.target.value === "__new__") {
                        setSupplierMode("new");
                        setSupplier("");
                      } else {
                        setSupplier(e.target.value);
                      }
                    }}
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                  >
                    <option value="">— Select supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                    <option value="__new__">+ New supplier…</option>
                  </select>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      placeholder="e.g. Kinapharma"
                      className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSupplierMode("select");
                        setSupplier("");
                      }}
                      className="shrink-0 rounded border border-outline-variant px-2 text-label-md text-on-surface hover:bg-surface-variant"
                    >
                      Select
                    </button>
                  </div>
                )}
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Cost (GH₵)</span>
                <input value={costPrice} onChange={(e) => setCostPrice(e.target.value)} placeholder="0.00" inputMode="decimal" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Selling (GH₵) *</span>
                <input value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} placeholder="0.00" inputMode="decimal" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Stock qty</span>
                <input value={stockQty} onChange={(e) => setStockQty(e.target.value)} placeholder="0" inputMode="numeric" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Reorder lvl</span>
                <input value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} placeholder="10" inputMode="numeric" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Pack size</span>
                <input value={packSize} onChange={(e) => setPackSize(e.target.value)} placeholder="1" inputMode="numeric" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Batch no</span>
                <input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="Optional" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none" />
              </label>
            </div>

            <label className="block">
              <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Expiry date</span>
              <DateField value={expiryDate} onChange={setExpiryDate} className="h-9 w-full" />
            </label>
          </div>
          {error && <p className="mt-3 text-body-sm font-body-sm text-error">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button onClick={onClose} className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant">Cancel</button>
          <button onClick={() => void submit()} disabled={busy} className="rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50">{busy ? "Saving…" : "Add Product"}</button>
        </div>
      </div>
    </div>
  );
}
