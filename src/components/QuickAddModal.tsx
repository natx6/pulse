import { useState } from "react";
import { useStore } from "../store/useStore";
import { quickAddProduct } from "../db";
import { beep } from "../lib/audio";

/** Quick-add: unknown scanned barcode, or manual cart item (no barcode). */
export function QuickAddModal() {
  const quickAdd = useStore((s) => s.quickAdd);
  const setQuickAdd = useStore((s) => s.setQuickAdd);
  const addToCart = useStore((s) => s.addToCart);
  const refreshProducts = useStore((s) => s.refreshProducts);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      const id = await quickAddProduct(nm, pr);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
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
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Paracetamol 500mg"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
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
