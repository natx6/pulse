import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { intakeStock } from "../db";
import { beep } from "../lib/audio";

/** Receive-stock intake: scan barcode, update existing product or create new. */
export function IntakeModal() {
  const open = useStore((s) => s.intakeOpen);
  const setIntakeOpen = useStore((s) => s.setIntakeOpen);
  const products = useStore((s) => s.products);
  const refreshProducts = useStore((s) => s.refreshProducts);

  const [barcode, setBarcode] = useState("");
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [batch, setBatch] = useState("");
  const [expiry, setExpiry] = useState("");
  const [supplier, setSupplier] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setBarcode("");
      setName("");
      setQty("");
      setCost("");
      setPrice("");
      setBatch("");
      setExpiry("");
      setSupplier("");
      setManufacturer("");
      setCategory("");
      setUnit("");
      setMessage(null);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const lookup = () => {
    const code = barcode.trim();
    if (!code) return;
    const p = products.find((x) => x.barcode === code);
    if (p) {
      setName(p.name);
      setPrice(String(p.selling_price));
      setCost(p.cost_price > 0 ? String(p.cost_price) : "");
      setBatch(p.batch_no ?? "");
      setExpiry(p.expiry_date ?? "");
      setSupplier(p.supplier ?? "");
      setManufacturer(p.manufacturer ?? "");
      setCategory(p.category ?? "");
      setUnit(p.unit ?? "");
      setMessage({ ok: true, text: `${p.name} — adding to existing stock.` });
    } else {
      setMessage({ ok: false, text: "New barcode — fill the details to create it." });
    }
  };

  const submit = async () => {
    const nm = name.trim();
    const n = Number(qty);
    const p = Number(price);
    if (!nm || !(n > 0)) {
      setMessage({ ok: false, text: "Name and quantity are required." });
      return;
    }
    if (!(p > 0)) {
      setMessage({ ok: false, text: "Retail price is required." });
      return;
    }
    setBusy(true);
    try {
      const res = await intakeStock({
        barcode: barcode.trim() || null,
        name: nm,
        quantity: n,
        costPrice: cost ? Number(cost) : null,
        sellingPrice: p,
        batchNo: batch.trim() || null,
        expiryDate: expiry || null,
        supplier: supplier.trim() || null,
        manufacturer: manufacturer.trim() || null,
        category: category.trim() || null,
        unit: unit.trim() || null,
      });
      await refreshProducts();
      beep(true);
      setMessage({
        ok: true,
        text: res.created
          ? `Created "${nm}" with ${n} in stock.`
          : `${nm} now +${n} in stock.`,
      });
      setTimeout(() => {
        setIntakeOpen(false);
        setMessage(null);
      }, 900);
    } catch (e) {
      setMessage({ ok: false, text: String(e).replace(/^Error: /, "") });
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          (e.target as HTMLElement).id !== "intake-barcode" &&
          (e.target as HTMLElement).tagName !== "TEXTAREA"
        )
          void submit();
        if (e.key === "Escape") setIntakeOpen(false);
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary-container p-1.5 text-on-primary-container">
              <span className="material-symbols-outlined text-[20px]">
                system_update_alt
              </span>
            </div>
            <div>
              <h3 className="text-headline-md font-headline-md text-on-surface">
                Inventory Intake
              </h3>
              <p className="text-body-sm font-body-sm text-on-surface-variant">
                Scan or enter details for incoming stock.
              </p>
            </div>
          </div>
          <button
            onClick={() => setIntakeOpen(false)}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
            title="Cancel [Esc]"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-1 block text-label-md font-label-md text-on-surface">
                Barcode Scan (NDC/UPC)
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-2 text-[20px] text-primary">
                  qr_code_scanner
                </span>
                <input
                  ref={scanRef}
                  id="intake-barcode"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      lookup();
                    }
                  }}
                  placeholder="Waiting for scan..."
                  className="h-9 w-full rounded border-2 border-primary bg-surface-bright pl-10 pr-3 font-data-mono text-data-mono text-on-surface shadow-sm focus:outline-none"
                />
                <div className="absolute right-3 top-3 h-2 w-2 animate-pulse rounded-full bg-primary" />
              </div>
            </div>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Product Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Amoxicillin 500mg Capsules"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Quantity
              </span>
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                placeholder="0"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Supplier
              </span>
              <input
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                placeholder="e.g. McKesson"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Manufacturer
              </span>
              <input
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="e.g. GSK"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Category
              </span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Antibiotics"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Batch / Lot ID
              </span>
              <input
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
                placeholder="Optional"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Unit of Measure
              </span>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="e.g. strip (10 tabs), bottle (100 caps)"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Expiration Date
              </span>
              <input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Unit Cost (GH₵)
              </span>
              <input
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Retail Price (GH₵)
              </span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
          </div>
          {message && (
            <p
              className={`mt-4 text-body-sm font-body-sm ${
                message.ok ? "text-primary" : "text-error"
              }`}
            >
              {message.text}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={() => setIntakeOpen(false)}
            className="flex items-center gap-2 rounded border border-outline px-4 py-2 text-on-surface transition-colors hover:bg-surface-variant"
          >
            <span className="text-label-md font-label-md">Cancel</span>
            <span className="rounded border border-outline-variant bg-surface px-1 text-shortcut-hint font-shortcut-hint opacity-70">
              Esc
            </span>
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="flex items-center gap-2 rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            <span className="text-label-md font-label-md">Confirm Intake</span>
            <span className="rounded border border-transparent bg-primary-container px-1 text-shortcut-hint font-shortcut-hint text-on-primary-container opacity-80">
              Enter
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
