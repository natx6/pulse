import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { stockStatus } from "../lib/stock";
import { fmtMoney } from "../lib/money";
import { adjustStock, loadProductsAll, setProductActive } from "../db";
import { beep } from "../lib/audio";
import { LabelModal } from "../components/LabelModal";
import { ImportStockModal } from "../components/ImportStockModal";
import type { Product } from "../types";

function StatusPill({ p }: { p: Pick<Product, "stock_qty" | "expiry_date" | "reorder_level"> }) {
  const st = stockStatus(p as Product);
  if (st === "critical")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-error/20 bg-error-container px-2 py-0.5 text-[10px] font-bold leading-tight text-on-error-container">
        <span className="h-1.5 w-1.5 rounded-full bg-error" /> Critical
      </span>
    );
  if (st === "low")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[#fef08a] bg-[#fef08a]/20 px-2 py-0.5 text-[10px] font-bold leading-tight text-[#854d0e]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#eab308]" /> Reorder Soon
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-surface-container px-2 py-0.5 text-[10px] font-bold leading-tight text-primary">
      <span className="h-1.5 w-1.5 rounded-full bg-primary" /> In Stock
    </span>
  );
}

export function InventoryPage() {
  const products = useStore((s) => s.products);
  const setIntakeOpen = useStore((s) => s.setIntakeOpen);
  const refreshProducts = useStore((s) => s.refreshProducts);
  const operator = useStore((s) => s.operator);
  const [q, setQ] = useState("");
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("Damaged");
  const [note, setNote] = useState("");
  const [adjustErr, setAdjustErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Product[]>([]);
  const [archiveArmed, setArchiveArmed] = useState<number | null>(null);

  // Load archived products when the toggle is on (active ones come from the store).
  useEffect(() => {
    if (!showArchived) return;
    let cancelled = false;
    void loadProductsAll().then((all) => {
      if (!cancelled) setArchived(all.filter((p) => !p.active));
    });
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  const list = showArchived ? archived : products;

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.barcode ?? "").includes(s) ||
        (p.supplier ?? "").toLowerCase().includes(s),
    );
  }, [list, q]);

  /** Two-step archive (mirrors operator delete): tap once to arm, again to run. */
  const armArchive = async (p: Product) => {
    if (archiveArmed !== p.id) {
      setArchiveArmed(p.id);
      window.setTimeout(() => setArchiveArmed((a) => (a === p.id ? null : a)), 2500);
      return;
    }
    setArchiveArmed(null);
    try {
      await setProductActive(p.id, 0);
      await refreshProducts();
      if (showArchived) {
        setArchived((a) => a.filter((x) => x.id !== p.id));
      }
      beep(true);
    } catch (e) {
      setAdjustErr(String(e));
      beep(false);
    }
  };

  const doRestore = async (p: Product) => {
    try {
      await setProductActive(p.id, 1);
      setArchived((a) => a.filter((x) => x.id !== p.id));
      await refreshProducts();
      beep(true);
    } catch (e) {
      setAdjustErr(String(e));
      beep(false);
    }
  };

  const openAdjust = (p: Product) => {
    setAdjust(p);
    setDelta("");
    setReason("Damaged");
    setNote("");
    setAdjustErr("");
  };

  const doAdjust = async () => {
    if (!adjust) return;
    const d = Math.floor(Number(delta));
    if (!delta.trim() || Number.isNaN(d) || d === 0) {
      setAdjustErr("Enter a non-zero quantity (use − to reduce).");
      beep(false);
      return;
    }
    setBusy(true);
    setAdjustErr("");
    try {
      const fullReason = note.trim() ? `${reason} — ${note.trim()}` : reason;
      await adjustStock(adjust.id, d, fullReason, operator);
      await refreshProducts();
      beep(true);
      setAdjust(null);
    } catch (e) {
      setAdjustErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const ADJUST_REASONS = ["Damaged", "Expired", "Counting error", "Returned to supplier", "Other"];

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="mb-1 text-headline-md font-headline-md text-on-surface">
            Inventory Management
          </h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">
            Stock levels, batches, and suppliers. Status updates live after every sale.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              search
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search Inventory..."
              className="h-8 w-64 rounded border border-outline-variant bg-surface-container-low pl-8 pr-12 text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="absolute right-2 top-1/2 flex h-4 -translate-y-1/2 items-center rounded-[2px] border border-outline-variant bg-surface-container px-1 text-shortcut-hint font-shortcut-hint text-on-surface-variant">
              Ctrl+K
            </span>
          </div>
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={`flex items-center gap-2 rounded border px-3 py-1.5 transition-colors ${
              showArchived
                ? "border-primary bg-primary/10 text-primary"
                : "border-outline-variant text-on-surface hover:bg-surface-container-low"
            }`}
            title={showArchived ? "Showing archived — tap to go back to live stock" : "List archived (discontinued) products"}
          >
            <span className="material-symbols-outlined text-[16px]">archive</span>
            <span className="text-label-md font-label-md">
              {showArchived ? "Archived on" : "Show archived"}
            </span>
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-on-surface transition-colors hover:bg-surface-container-low"
            title="Bulk-load stock from an Excel or CSV export of your old system"
          >
            <span className="material-symbols-outlined text-[16px]">upload_file</span>
            <span className="text-label-md font-label-md">Import Stock</span>
          </button>
          <button
            onClick={() => setLabelOpen(true)}
            className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-on-surface transition-colors hover:bg-surface-container-low"
            title="Print a scannable Code39 shelf label"
          >
            <span className="material-symbols-outlined text-[16px]">print</span>
            <span className="text-label-md font-label-md">Print Label</span>
          </button>
          <button
            onClick={() => setIntakeOpen(true)}
            className="flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
          >
            <span className="material-symbols-outlined text-[16px]">add_box</span>
            <span className="text-label-md font-label-md">Receive Stock</span>
            <span className="rounded-[2px] border border-on-primary/30 px-1 text-shortcut-hint font-shortcut-hint opacity-80">
              [F2]
            </span>
          </button>
        </div>
      </div>

      <div className="flex h-[calc(100vh-14rem)] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
        <div className="flex items-center border-b border-outline-variant bg-surface-container-low px-4 py-2">
          <div className="flex-1 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Item Name
          </div>
          <div className="w-28 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Batch
          </div>
          <div className="w-36 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Supplier
          </div>
          <div className="w-40 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Barcode ID
          </div>
          <div className="w-28 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Expiry
          </div>
          <div className="w-20 text-right pr-2 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Qty
          </div>
          <div className="w-28 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Status
          </div>
          <div className="w-20 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Actions
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="p-8 text-center text-body-sm text-on-surface-variant">
              No items found.
            </p>
          )}
          {filtered.map((p) => {
            const st = stockStatus(p);
            return (
              <div
                key={p.id}
                className={`group flex items-center border-b border-outline-variant px-4 transition-colors hover:bg-surface-container-low ${
                  st === "critical" ? "border-l-[3px] border-l-error bg-error/5" : ""
                }`}
                style={{ height: 36 }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 pr-4">
                  <span className="truncate text-body-sm font-medium text-on-surface">
                    {p.name}
                  </span>
                  {p.is_controlled ? (
                    <span
                      className="shrink-0 rounded bg-[#7f1d1d] px-1.5 py-0.5 text-[10px] font-bold text-white"
                      title="Controlled drug — see the register in Reports"
                    >
                      C
                    </span>
                  ) : null}
                </div>
                <div className="w-28 truncate font-data-mono text-data-mono text-on-surface-variant">
                  {p.batch_no ?? "—"}
                </div>
                <div className="w-36 truncate pr-4 text-body-sm text-on-surface-variant">
                  {p.supplier ?? "—"}
                </div>
                <div className="w-40 truncate font-data-mono text-data-mono text-on-surface-variant">
                  {p.barcode ?? "—"}
                </div>
                <div
                  className={`w-28 text-body-sm ${
                    st === "critical" ? "font-medium text-error" : "text-on-surface-variant"
                  }`}
                >
                  {p.expiry_date ?? "—"}
                </div>
                <div className="w-20 pr-4 text-right font-data-mono text-data-mono text-on-surface">
                  {p.stock_qty}
                </div>
                <div className="w-28">
                  <StatusPill p={p} />
                </div>
                <div className="w-20 pr-1 text-right">
                  {p.active ? (
                    <span className="inline-flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => openAdjust(p)}
                        title={`Adjust stock (damaged, expired, counting error…) — now ${p.stock_qty}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-outline hover:bg-surface-variant hover:text-on-surface"
                      >
                        <span className="material-symbols-outlined text-[15px]">tune</span>
                      </button>
                      <button
                        onClick={() => void armArchive(p)}
                        title="Archive — removes it from the POS and Inventory (two taps)"
                        className={`inline-flex h-6 items-center gap-0.5 rounded px-1 ${
                          archiveArmed === p.id
                            ? "bg-error/10 text-error"
                            : "text-outline hover:bg-surface-variant hover:text-error"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[15px]">archive</span>
                        {archiveArmed === p.id && (
                          <span className="text-[10px] font-bold">Again?</span>
                        )}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => void doRestore(p)}
                      title="Restore — bring it back to the POS and Inventory"
                      className="inline-flex h-6 items-center gap-0.5 rounded px-1 text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100"
                    >
                      <span className="material-symbols-outlined text-[15px]">unarchive</span>
                      <span className="text-[10px] font-bold">Restore</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex h-10 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container-low px-4">
          <div className="text-body-sm font-body-sm text-on-surface-variant">
            {filtered.length} of {list.length} items
            {showArchived ? " (archived)" : ""}
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 text-body-sm font-body-sm text-on-surface">Cost of stock:</span>
            <span className="font-data-mono text-data-mono font-bold text-primary">
              {fmtMoney(
                list.reduce((s, p) => s + p.cost_price * p.stock_qty, 0),
              )}
            </span>
          </div>
        </div>
      </div>

      {adjust && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-5 shadow-lg">
            <h3 className="mb-1 text-headline-md font-headline-md text-on-surface">
              Adjust — {adjust.name}
            </h3>
            <p className="mb-4 text-body-sm font-body-sm text-on-surface-variant">
              Currently {adjust.stock_qty} in stock. Use − to reduce (e.g. −2 for
              two damaged units).
            </p>
            <label className="mb-1 block text-label-md font-label-md text-on-surface">
              Quantity change
            </label>
            <input
              autoFocus
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="e.g. 5 or −2"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {delta.trim() && !Number.isNaN(Number(delta)) && (
              <p className="mt-1 text-body-sm font-body-sm text-on-surface-variant">
                Result:{" "}
                <span className="font-bold text-on-surface">
                  {adjust.stock_qty + Math.floor(Number(delta))}
                </span>
                {adjust.stock_qty + Math.floor(Number(delta)) < 0 && (
                  <span className="text-error"> — can't go below zero</span>
                )}
              </p>
            )}
            <label className="mb-1 mt-4 block text-label-md font-label-md text-on-surface">
              Reason
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-md text-on-surface focus:border-primary focus:outline-none"
            >
              {ADJUST_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="mt-2 h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {adjustErr && <p className="mt-2 text-body-sm font-body-sm text-error">{adjustErr}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setAdjust(null)}
                className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Cancel
              </button>
              <button
                onClick={() => void doAdjust()}
                disabled={busy}
                className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save adjustment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {labelOpen && <LabelModal onClose={() => setLabelOpen(false)} />}
      {importOpen && (
        <ImportStockModal
          onClose={() => setImportOpen(false)}
          onDone={() => void refreshProducts()}
        />
      )}
    </div>
  );
}
