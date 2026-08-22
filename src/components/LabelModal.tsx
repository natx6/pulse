import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import { code39Bars, code39Valid, code39Width } from "../lib/barcode39";
import type { Product } from "../types";

interface Props {
  onClose(): void;
}

/** Print a Code39 shelf label: pick a product or type a barcode (e.g. a
 * QuickAdd product's fake barcode, which then becomes scannable). */
export function LabelModal({ onClose }: Props) {
  const products = useStore((s) => s.products);
  const pharmacyName = useStore((s) => s.pharmacyName);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [manual, setManual] = useState("");

  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return products
      .filter((p) => p.name.toLowerCase().includes(s) || (p.barcode ?? "").includes(s))
      .slice(0, 6);
  }, [products, search]);

  const code = manual.trim() || selected?.barcode?.trim() || "";
  const bars = useMemo(() => code39Bars(code), [code]);
  const width = code39Width(code);
  const valid = code39Valid(code);
  const NARROW = 3; // px per narrow unit at display size

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">Print Label</h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              A Code39 shelf label — scannable at the counter.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex flex-col gap-4 p-6">
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Pick a product
            </span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelected(null);
              }}
              placeholder="Search catalog…"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          {search.trim() && matches.length === 0 && (
            <p className="text-body-sm text-on-surface-variant">No matches.</p>
          )}
          {matches.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setSelected(p);
                setSearch("");
                setManual("");
              }}
              className="flex w-full items-center justify-between rounded border border-outline-variant/50 px-3 py-1.5 text-left hover:bg-surface-container-low"
            >
              <span className="min-w-0 truncate text-body-sm text-on-surface">{p.name}</span>
              <span className="ml-2 shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                {p.barcode ?? "no barcode"}
              </span>
            </button>
          ))}

          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              …or type any barcode
            </span>
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value.toUpperCase())}
              placeholder="e.g. the code QuickAdd gave an item"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {code && width > 0 && valid ? (
            <div
              id="label-area"
              className="mx-auto w-full rounded border border-outline-variant bg-white p-4"
              style={{ width: 60 * 3.78 }} // ~60mm at 96dpi
            >
              <p className="mb-0.5 text-center text-[12px] font-bold leading-tight text-black">
                {selected?.name ?? (manual.trim() ? pharmacyName : "")}
              </p>
              {selected?.strength && (
                <p className="text-center text-[10px] font-semibold text-black/70">
                  {selected.strength}{selected.unit ? ` · ${selected.unit}` : ""}
                </p>
              )}
              {!selected?.strength && selected?.unit && (
                <p className="text-center text-[10px] font-semibold text-black/70">
                  {selected.unit}
                </p>
              )}
              <svg
                width={width * NARROW}
                height={60}
                viewBox={`0 0 ${width} 60`}
                className="mx-auto mt-1 block"
                preserveAspectRatio="none"
              >
                {bars.map((b, i) => (
                  <rect key={i} x={b.x} y={0} width={b.width} height={50} fill="#000" />
                ))}
              </svg>
              <p className="mt-0.5 text-center font-data-mono text-[11px] font-semibold tracking-widest text-black">
                {code}
              </p>
              {selected && (
                <p className="text-center text-[16px] font-black text-black">
                  {fmtMoney(selected.selling_price)}
                </p>
              )}
            </div>
          ) : (
            <p className="py-6 text-center text-body-sm text-on-surface-variant">
              {code
                ? "That barcode has characters Code39 can't print (A–Z, 0–9, − . space $ / + %)."
                : "Pick a product or type a barcode to see the label."}
            </p>
          )}
        </div>

        <div className="flex gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={onClose}
            className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
          >
            Cancel
          </button>
          <button
            onClick={() => window.print()}
            disabled={width === 0 || !valid}
            className="flex flex-1 items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">print</span>
            Print label
          </button>
        </div>
      </div>
    </div>
  );
}
