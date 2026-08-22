import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { commitStockTake, isManagerPinSet } from "../db";
import { beep } from "../lib/audio";
import { useToast } from "../store/toast";
import { useFocusTrap } from "../lib/focusTrap";

interface Props {
  onClose(): void;
}

/** Bulk physical count: type what's actually on the shelf for any subset of
 * products. Only variances are committed — one transaction in Rust that
 * corrects stock, moves the FEFO ledger and writes a 'Stock take' audit row
 * per change. Blank input = "didn't count this one", never a correction. */
export function StockTakeModal({ onClose }: Props) {
  const products = useStore((s) => s.products);
  const operator = useStore((s) => s.operator);
  const refreshProducts = useStore((s) => s.refreshProducts);

  const [q, setQ] = useState("");
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** Manager PIN — required only when the count reduces something. */
  const [pinRequired, setPinRequired] = useState(false);
  const [managerPin, setManagerPin] = useState("");
  const dialogRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    void isManagerPinSet().then(setPinRequired).catch(() => setPinRequired(false));
  }, []);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter(
      (p) =>
        !s ||
        p.name.toLowerCase().includes(s) ||
        (p.barcode ?? "").includes(s),
    );
  }, [products, q]);

  /** Non-blank counted values keyed for the commit payload. */
  const entered = useMemo(
    () =>
      Object.entries(counts)
        .filter(([, v]) => v.trim() !== "")
        .map(([id, v]) => ({ id: Number(id), n: Number(v) }))
        .filter((e) => Number.isFinite(e.n) && e.n >= 0),
    [counts],
  );

  const varianceCount = entered.filter((e) => {
    const p = products.find((x) => x.id === e.id);
    return p && p.stock_qty !== e.n;
  }).length;

  /** Reductions are the shrinkage vector — they need the manager PIN. */
  const reductionCount = entered.filter((e) => {
    const p = products.find((x) => x.id === e.id);
    return p && e.n < p.stock_qty;
  }).length;

  const invalidInput = Object.entries(counts).some(
    ([, v]) => v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0),
  );

  const doCommit = async () => {
    if (invalidInput || entered.length === 0) return;
    if (pinRequired && reductionCount > 0 && managerPin.trim().length < 4) {
      setErr("Manager PIN required — this count reduces stock.");
      beep(false);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await commitStockTake(
        entered.map((e) => ({ product_id: e.id, counted: e.n })),
        operator || null,
        managerPin.trim() || null,
      );
      await refreshProducts();
      beep(true);
      if (r.changed === 0) {
        useToast.getState().show("Count saved — shelf matched the books.", "success");
      } else {
        useToast.getState().show(
          `Stock take committed — ${r.changed} item${r.changed === 1 ? "" : "s"} corrected, logged in the audit list.`,
          "success",
          { duration: 6000 },
        );
      }
      onClose();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stocktake-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 id="stocktake-title" className="text-headline-md font-headline-md text-on-surface">
              Stock take
            </h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              Count the shelf, enter what you see. Only differences are
              applied — each one is logged with your name.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
            title="Cancel [Esc]"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="border-b border-outline-variant bg-surface px-6 py-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter items by name or barcode…"
            className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && (
            <p className="p-6 text-center text-body-sm text-on-surface-variant">
              No matching items.
            </p>
          )}
          {rows.map((p) => {
            const raw = counts[p.id]?.trim() ?? "";
            const n = Number(raw);
            const delta = raw === "" ? null : Number.isFinite(n) ? n - p.stock_qty : null;
            return (
              <div
                key={p.id}
                className="flex items-center gap-4 border-b border-outline-variant/40 px-6 py-1.5 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-body-md text-on-surface">
                  {p.name}
                </span>
                <span
                  className="w-16 shrink-0 text-right font-data-mono text-data-mono text-on-surface-variant"
                  title="System quantity"
                >
                  {p.stock_qty}
                </span>
                <input
                  type="number"
                  min={0}
                  value={counts[p.id] ?? ""}
                  onChange={(e) =>
                    setCounts((c) => ({ ...c, [p.id]: e.target.value }))
                  }
                  placeholder="—"
                  aria-label={`Counted quantity for ${p.name}`}
                  title="What's actually on the shelf (blank = not counted)"
                  className="h-8 w-20 shrink-0 rounded border border-outline-variant bg-surface-container-lowest px-2 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span
                  className={`w-14 shrink-0 text-right font-data-mono text-data-mono ${
                    delta === null || delta === 0
                      ? "text-on-surface-variant"
                      : delta > 0
                        ? "font-bold text-primary"
                        : "font-bold text-error"
                  }`}
                >
                  {delta === null || delta === 0 ? "" : delta > 0 ? `+${delta}` : delta}
                </span>
              </div>
            );
          })}
        </div>

        {(err || invalidInput) && (
          <p className="mx-6 mb-1 mt-2 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
            {err ||
              "Some counts aren't valid numbers — fix them before committing."}
          </p>
        )}

        {pinRequired && reductionCount > 0 && (
          <div className="mx-6 mb-2">
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Manager PIN — this count reduces stock
              </span>
              <input
                type="password"
                inputMode="numeric"
                value={managerPin}
                onChange={(e) => setManagerPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="••••"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono tracking-[0.3em] text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-outline-variant bg-surface-container px-6 py-4">
          <span className="font-data-mono text-data-mono text-on-surface-variant">
            {varianceCount} difference{varianceCount === 1 ? "" : "s"} to apply
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
            >
              Cancel
            </button>
            <button
              onClick={() => void doCommit()}
              disabled={busy || invalidInput || varianceCount === 0}
              className="rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              {busy ? "Committing…" : `Commit ${varianceCount} correction${varianceCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
