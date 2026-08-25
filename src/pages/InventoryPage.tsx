import { Fragment, useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { stockStatus } from "../lib/stock";
import { fmtMoney } from "../lib/money";
import { adjustStock, isManagerPinSet, loadBatches, loadProductsAll, savePackSize, saveReorderLevel, setProductActive } from "../db";
import { beep } from "../lib/audio";
import { useToast } from "../store/toast";
import { useFocusTrap } from "../lib/focusTrap";
import { LabelModal } from "../components/LabelModal";
import { ImportStockModal } from "../components/ImportStockModal";
import { StockTakeModal } from "../components/StockTakeModal";
import type { BatchRow, Product } from "../types";

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
      <span className="inline-flex items-center gap-1 rounded-full border border-warn bg-warn-subtle px-2 py-0.5 text-[10px] font-bold leading-tight text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-[#eab308] dark:bg-[#fbbf24]" /> Reorder Soon
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
  const [stockTakeOpen, setStockTakeOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Product[]>([]);
  const [archiveArmed, setArchiveArmed] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<"name" | "batch" | "supplier" | "barcode" | "expiry" | "qty" | "reorder">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [editingReorder, setEditingReorder] = useState<number | null>(null);
  const [reorderVal, setReorderVal] = useState("");
  /** Expanded product row → its FEFO batches (loaded lazily). */
  const [expanded, setExpanded] = useState<number | null>(null);
  const [batchRows, setBatchRows] = useState<Record<number, BatchRow[]>>({});
  const adjustDialogRef = useFocusTrap<HTMLDivElement>();

  const toggleBatches = async (p: Product) => {
    if (expanded === p.id) {
      setExpanded(null);
      return;
    }
    setExpanded(p.id);
    if (!batchRows[p.id]) {
      try {
        const rows = await loadBatches(p.id);
        setBatchRows((m) => ({ ...m, [p.id]: rows }));
      } catch {
        setBatchRows((m) => ({ ...m, [p.id]: [] }));
      }
    }
  };

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
    let rows = list;
    if (s) {
      rows = rows.filter(
        (p) =>
          p.name.toLowerCase().includes(s) ||
          (p.barcode ?? "").includes(s) ||
          (p.supplier ?? "").toLowerCase().includes(s),
      );
    }
    const key = sortKey;
    const dir = sortAsc ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (key === "name") cmp = a.name.localeCompare(b.name);
      else if (key === "batch") cmp = (a.batch_no ?? "").localeCompare(b.batch_no ?? "");
      else if (key === "supplier") cmp = (a.supplier ?? "").localeCompare(b.supplier ?? "");
      else if (key === "barcode") cmp = (a.barcode ?? "").localeCompare(b.barcode ?? "");
      else if (key === "expiry") cmp = (a.expiry_date ?? "zzz").localeCompare(b.expiry_date ?? "zzz");
      else if (key === "qty") cmp = a.stock_qty - b.stock_qty;
      else if (key === "reorder") cmp = a.reorder_level - b.reorder_level;
      return cmp * dir;
    });
  }, [list, q, sortKey, sortAsc]);

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };
  const arrow = (key: typeof sortKey) => sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

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
      // No modal is open during archive/restore, so the error has to be a
      // toast — a local banner (like adjustErr) would only ever render
      // inside the unrelated Adjust modal.
      useToast.getState().show(String(e).replace(/^Error: /, ""), "error");
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
      useToast.getState().show(String(e).replace(/^Error: /, ""), "error");
      beep(false);
    }
  };

  const [adjustReorder, setAdjustReorder] = useState("");
  const [adjustPack, setAdjustPack] = useState("");
  /** Manager PIN — required for reductions when one is configured. */
  const [pinRequired, setPinRequired] = useState(false);
  const [adjustPin, setAdjustPin] = useState("");

  useEffect(() => {
    void isManagerPinSet().then(setPinRequired).catch(() => setPinRequired(false));
  }, []);

  const openAdjust = (p: Product) => {
    setAdjust(p);
    setDelta("");
    setReason("Damaged");
    setNote("");
    setAdjustErr("");
    setAdjustReorder(String(p.reorder_level));
    setAdjustPack(String(p.pack_size ?? 1));
    setAdjustPin("");
  };

  const doAdjust = async () => {
    if (!adjust) return;
    const d = Math.floor(Number(delta));
    const hasDelta = delta.trim() && !Number.isNaN(d) && d !== 0;
    const newLevel = Math.max(0, Math.floor(Number(adjustReorder)) || 0);
    const hasReorderChange = newLevel !== adjust.reorder_level;
    const newPack = Math.max(1, Math.floor(Number(adjustPack)) || 1);
    const hasPackChange = newPack !== (adjust.pack_size ?? 1);
    if (!hasDelta && !hasReorderChange && !hasPackChange) {
      setAdjustErr("Nothing to save — enter a quantity change or adjust the reorder level.");
      beep(false);
      return;
    }
    if (hasDelta && d < 0 && pinRequired && adjustPin.trim().length < 4) {
      setAdjustErr("Manager PIN required to reduce stock.");
      beep(false);
      return;
    }
    setBusy(true);
    setAdjustErr("");
    try {
      if (hasDelta) {
        const fullReason = note.trim() ? `${reason} — ${note.trim()}` : reason;
        await adjustStock(adjust.id, d, fullReason, operator, adjustPin.trim() || null);
      }
      if (hasReorderChange) {
        await saveReorderLevel(adjust.id, newLevel);
      }
      if (hasPackChange) {
        await savePackSize(adjust.id, newPack);
      }
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
            onClick={() => setStockTakeOpen(true)}
            className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-on-surface transition-colors hover:bg-surface-container-low"
            title="Count the whole shelf, commit the differences in one go"
          >
            <span className="material-symbols-outlined text-[16px]">checklist</span>
            <span className="text-label-md font-label-md">Stock take</span>
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
          {([
            ["name", "flex-1", "Item Name"],
            ["batch", "w-28", "Batch"],
            ["supplier", "w-36", "Supplier"],
            ["barcode", "w-40", "Barcode ID"],
            ["expiry", "w-28", "Expiry"],
            ["qty", "w-16 text-right pr-2", "Qty"],
            ["reorder", "w-16 text-right pr-2", "Min"],
          ] as const).map(([key, cls, label]) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={`${cls} font-label-md font-label-md uppercase tracking-wider text-on-surface-variant cursor-pointer hover:text-on-surface select-none transition-colors`}
            >
              {label}{arrow(key)}
            </button>
          ))}
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
              <Fragment key={p.id}>
              <div
                className={`group flex items-center border-b border-outline-variant px-4 transition-colors hover:bg-surface-container-low ${
                  st === "critical" ? "border-l-[3px] border-l-error bg-error/5" : ""
                }`}
                style={{ height: 36 }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 pr-4">
                  <button
                    onClick={() => void toggleBatches(p)}
                    title="Show batches (FEFO order — nearest expiry first)"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-outline hover:bg-surface-variant hover:text-on-surface"
                  >
                    <span className={`material-symbols-outlined text-[16px] transition-transform ${expanded === p.id ? "rotate-90" : ""}`}>
                      chevron_right
                    </span>
                  </button>
                  <span className="truncate text-body-sm font-medium text-on-surface">
                    {p.name}
                  </span>
                  {p.is_controlled ? (
                    <span
                      className="shrink-0 rounded bg-danger-deep px-1.5 py-0.5 text-[10px] font-bold text-white"
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
                <div className="w-16 pr-4 text-right font-data-mono text-data-mono text-on-surface">
                  {p.stock_qty}
                </div>
                <div className="w-16 pr-4 text-right font-data-mono text-data-mono text-on-surface-variant">
                  {editingReorder === p.id ? (
                    <input
                      autoFocus
                      type="number"
                      min="0"
                      value={reorderVal}
                      onChange={(e) => setReorderVal(e.target.value)}
                      onBlur={async () => {
                        const v = Math.max(0, Math.floor(Number(reorderVal)) || 0);
                        if (v !== p.reorder_level) {
                          await saveReorderLevel(p.id, v);
                          await refreshProducts();
                        }
                        setEditingReorder(null);
                      }}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          setEditingReorder(null);
                        }
                      }}
                      className="h-6 w-14 rounded border border-primary bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:outline-none"
                    />
                  ) : (
                    <span
                      onClick={() => { setEditingReorder(p.id); setReorderVal(String(p.reorder_level)); }}
                      className="cursor-pointer hover:text-on-surface"
                      title="Click to edit reorder level"
                    >
                      {p.reorder_level}
                    </span>
                  )}
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
              {expanded === p.id && (
                <div className="border-b border-outline-variant bg-surface-container-low px-4 py-2 pl-12">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                    Batches — sold nearest expiry first (FEFO)
                    {(p.pack_size ?? 1) > 1 ? ` · 1 pack = ${p.pack_size} units` : ""}
                  </p>
                  {!(batchRows[p.id] ?? []).some((b) => b.quantity > 0) && (
                    <p className="text-body-sm text-on-surface-variant">Nothing on the shelf.</p>
                  )}
                  {(batchRows[p.id] ?? [])
                    .filter((b) => b.quantity > 0 || b.batch_no)
                    .map((b) => (
                      <div key={b.id} className="flex items-center gap-4 py-0.5 font-data-mono text-data-mono text-body-sm">
                        <span className="w-32 truncate text-on-surface">{b.batch_no ?? "(no batch)"}</span>
                        <span className={`w-28 ${b.expiry_date && new Date(b.expiry_date + "T00:00:00") <= new Date() ? "font-bold text-error" : "text-on-surface-variant"}`}>
                          exp {b.expiry_date ?? "—"}
                        </span>
                        <span className="ml-auto text-right text-on-surface">
                          {b.quantity}
                          {(p.pack_size ?? 1) > 1 && b.quantity >= (p.pack_size ?? 1)
                            ? ` (${Math.floor(b.quantity / (p.pack_size ?? 1))} pk)`
                            : ""}
                        </span>
                      </div>
                    ))}
                </div>
              )}
              </Fragment>
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
        <div data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div
            ref={adjustDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="adjust-dialog-title"
            className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-5 shadow-lg"
          >
            <h3 id="adjust-dialog-title" className="mb-1 text-headline-md font-headline-md text-on-surface">
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
            {delta.trim() && !Number.isNaN(Number(delta)) && Number(delta) !== 0 && (
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
            <label className="mb-1 mt-3 block text-label-md font-label-md text-on-surface">
              Reorder level
            </label>
            <input
              type="number"
              min="0"
              value={adjustReorder}
              onChange={(e) => setAdjustReorder(e.target.value)}
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <label className="mb-1 mt-3 block text-label-md font-label-md text-on-surface">
              Units per pack (carton) — 1 = none
            </label>
            <input
              type="number"
              min="1"
              value={adjustPack}
              onChange={(e) => setAdjustPack(e.target.value)}
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {pinRequired && delta.trim() && Number(delta) < 0 && (
              <label className="mb-1 mt-3 block">
                <span className="mb-1 block text-label-md font-label-md text-on-surface">
                  Manager PIN — reducing stock is protected
                </span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={adjustPin}
                  onChange={(e) => setAdjustPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  placeholder="••••"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono tracking-[0.3em] text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
            )}
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
      {stockTakeOpen && <StockTakeModal onClose={() => setStockTakeOpen(false)} />}
    </div>
  );
}
