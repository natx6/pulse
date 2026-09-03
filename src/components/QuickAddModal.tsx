import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { quickAddProduct, searchFdaDrugs, type FdaDrug } from "../db";
import { beep } from "../lib/audio";

/** Quick-add: unknown scanned barcode, or manual cart item (no barcode). */
export function QuickAddModal() {
  const quickAdd = useStore((s) => s.quickAdd);
  const setQuickAdd = useStore((s) => s.setQuickAdd);
  const addToCart = useStore((s) => s.addToCart);
  const refreshProducts = useStore((s) => s.refreshProducts);
  const currentUser = useStore((s) => s.currentUser);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fdaAutocomplete = useStore((s) => s.fdaAutocomplete);
  const [fdaResults, setFdaResults] = useState<FdaDrug[]>([]);
  const [showFda, setShowFda] = useState(false);

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

  if (!quickAdd) return null;

  const isScan = quickAdd.barcode !== null;

  const close = () => {
    setQuickAdd(null);
    setName("");
    setPrice("");
    setError("");
  };

  const submit = async () => {
    const nm = name.trim();
    const pr = Number(price);
    if (!nm || !(pr > 0)) {
      setError("Name and a price above 0 are needed.");
      return;
    }
    setBusy(true);
    try {
      const id = await quickAddProduct(
        nm,
        pr,
        currentUser?.display_name ?? null,
        currentUser?.role ?? null,
      );
      await refreshProducts();
      const p = useStore.getState().products.find((x) => x.id === id);
      if (p) addToCart(p);
      beep(true);
      close();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        // preventDefault: Enter on a focused button would otherwise fire the
        // native click AND this handler — two submits from one keypress.
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
        if (e.key === "Escape") close();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary-container p-1.5 text-on-primary-container">
              <span className="material-symbols-outlined text-[20px]">
                {isScan ? "barcode_scanner" : "add"}
              </span>
            </div>
            <div>
              <h3 className="text-headline-md font-headline-md text-on-surface">
                {isScan ? "New Barcode" : "Add Manual Item"}
              </h3>
              <p className="text-body-sm font-body-sm text-on-surface-variant">
                {isScan
                  ? `No product found for ${quickAdd.barcode}. Create it — it goes straight to the cart.`
                  : "Item not in catalog — create it and it goes straight to the cart."}
              </p>
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Name
            </span>
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
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Selling Price (GH₵)
            </span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          {error && (
            <p className="text-body-sm font-body-sm text-error">{error}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={close}
              className="rounded border border-outline px-4 py-2 text-on-surface transition-colors hover:bg-surface-variant"
            >
              <span className="text-label-md font-label-md">Cancel</span>
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              <span className="text-label-md font-label-md">Add & Sell</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
