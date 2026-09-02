import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store/useStore";
import { backupDb, commitStockImport, parseStockFile, searchFdaDrugs } from "../db";
import type { FdaDrug, ImportSummary, ParsedSheet, StockImportRow } from "../db";
import { beep } from "../lib/audio";

/** Bulk-load stock from an Excel/CSV export of the old system:
 * pick file → auto-map columns → preview what will happen → confirm → commit
 * in one transaction (with a backup snapshot taken first). */
export function ImportStockModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const products = useStore((s) => s.products);
  const fdaAutocomplete = useStore((s) => s.fdaAutocomplete);
  const [phase, setPhase] = useState<"pick" | "map" | "done">("pick");
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [backupPath, setBackupPath] = useState("");
  const [fdaOverrides, setFdaOverrides] = useState<Record<number, string>>({});
  const [fdaSuggestions, setFdaSuggestions] = useState<Record<number, FdaDrug | null>>({});
  const [bulkFdaBusy, setBulkFdaBusy] = useState(false);

  const pickFile = async () => {
    setErr("");
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: "Stock export", extensions: ["xlsx", "xls", "ods", "csv"] }],
      });
      if (!file || typeof file !== "string") return;
      setFileName(file.split(/[\\/]/).pop() ?? file);
      const s = await parseStockFile(file);
      if (s.headers.length === 0 || s.rows.length === 0) {
        setErr("That file has no data rows. The first row must be the column headings.");
        return;
      }
      setSheet(s);
      setMapping(autoMap(s.headers));
      setPhase("map");
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
    }
  };

  const stats = useMemo(() => {
    if (!sheet) return null;
    const recs: StockImportRow[] = [];
    let skip = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      const r = rowToRecord(row, mapping);
      if (!r) {
        skip++;
        continue;
      }
      // Apply FDA override if the user accepted it for this row.
      if (fdaOverrides[i] !== undefined) r.name = fdaOverrides[i]!;
      recs.push(r);
    }
    let created = 0;
    let updated = 0;
    for (const r of recs) {
      const bc = (r.barcode ?? "").trim();
      const hit = bc
        ? products.some((p) => (p.barcode ?? "").trim() === bc)
        : products.some((p) => p.name.trim().toLowerCase() === r.name.trim().toLowerCase());
      if (hit) updated++;
      else created++;
    }
    return { total: sheet.rows.length, usable: recs.length, created, updated, skip, recs };
  }, [sheet, mapping, products, fdaOverrides]);

  // Fetch FDA suggestions for the preview rows (first 5) when the sheet/mapping changes.
  useEffect(() => {
    setFdaOverrides({});
    setFdaSuggestions({});
    if (!fdaAutocomplete || !sheet || phase !== "map") return;
    const idxs = sheet.rows.slice(0, 5).map((_, i) => i);
    idxs.forEach(async (i) => {
      const r = rowToRecord(sheet.rows[i], mapping);
      const q = r?.name?.trim();
      if (!q || q.length < 2) {
        setFdaSuggestions((m) => ({ ...m, [i]: null }));
        return;
      }
      try {
        const res = await searchFdaDrugs(q, 1);
        setFdaSuggestions((m) => ({ ...m, [i]: res[0] ?? null }));
      } catch {
        setFdaSuggestions((m) => ({ ...m, [i]: null }));
      }
    });
  }, [sheet, mapping, phase, fdaAutocomplete]);

  const doImport = async () => {
    if (!stats || stats.recs.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      const bpath = await backupDb();
      const res = await commitStockImport(stats.recs);
      setSummary(res);
      setBackupPath(bpath);
      setPhase("done");
      onDone();
      beep(true);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  /** Two-step confirm (mirrors void/archive): tap once to arm, again to run. */
  const armImport = () => {
    if (!stats || stats.recs.length === 0) return;
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed((a) => (a ? false : a)), 4000);
      return;
    }
    setArmed(false);
    void doImport();
  };

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant px-5 py-3">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">
              Import Stock
            </h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              Load your old system's stock list in one go.
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {err && (
            <p className="mb-3 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
              {err}
            </p>
          )}

          {phase === "pick" && (
            <div>
              <button
                onClick={() => void pickFile()}
                className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-outline-variant bg-surface-container-lowest px-6 py-10 text-on-surface transition-colors hover:border-primary hover:bg-primary/5"
              >
                <span className="material-symbols-outlined text-[40px] text-primary">
                  upload_file
                </span>
                <span className="text-body-md font-body-md">
                  Choose the file from your old system
                </span>
                <span className="text-body-sm font-body-sm text-on-surface-variant">
                  Excel (.xlsx, .xls) or CSV — up to 5,000 rows
                </span>
              </button>
              <p className="mt-4 text-body-sm font-body-sm text-on-surface-variant">
                Everything lands in one transaction: matching items get their prices
                refreshed and quantity added; new items are created. A backup is
                taken automatically before the import.
              </p>
            </div>
          )}

          {phase === "map" && sheet && stats && (
            <div>
              <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
                {fileName} — check that each column maps to the right field.
                Anything left as "— ignore —" stays blank.
              </p>

              <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-0.5 block text-label-md font-label-md text-on-surface">
                      {f.label}
                    </span>
                    <select
                      value={mapping[f.key] ?? -1}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setMapping((m) => {
                          const next = { ...m };
                          if (v < 0) delete next[f.key];
                          else next[f.key] = v;
                          return next;
                        });
                      }}
                      className="h-8 w-full rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                    >
                      <option value={-1}>— ignore —</option>
                      {sheet.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              {stats.recs.length > 0 && (
                <div className="mb-4 overflow-hidden rounded-xl border border-outline-variant">
                  <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-3 py-2">
                    <p className="text-label-md font-label-md font-bold text-on-surface">
                      Review — {stats.recs.length.toLocaleString()} rows as they'll be read
                    </p>
                    <span className="text-[11px] text-on-surface-variant">Scroll to see all</span>
                  </div>
                  <div className="max-h-[50vh] overflow-auto">
                    <table className="w-full border-collapse text-left text-body-sm">
                      <thead className="sticky top-0 bg-surface-container-low text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
                        <tr>
                          <th className="px-3 py-1.5">#</th>
                          <th className="px-3 py-1.5">Name</th>
                          <th className="px-3 py-1.5">Barcode</th>
                          <th className="px-3 py-1.5 text-right">Qty</th>
                          <th className="px-3 py-1.5 text-right">Price</th>
                          <th className="px-3 py-1.5">FDA</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant/30">
                        {stats.recs.map((r, i) => {
                          const ov = fdaOverrides[i];
                          const sug = fdaSuggestions[i];
                          const displayName = ov ?? r.name;
                          const showSug = sug && sug.product_name.toLowerCase() !== r.name.toLowerCase() && !ov;
                          return (
                            <tr key={i} className="hover:bg-surface-container-low/50">
                              <td className="px-3 py-1 font-data-mono text-data-mono text-on-surface-variant">{i + 1}</td>
                              <td className="max-w-[260px] truncate px-3 py-1 font-medium text-on-surface" title={displayName}>
                                {displayName}
                                {showSug && (
                                  <div className="mt-0.5 flex items-center gap-1 rounded bg-primary/5 px-1 py-0.5">
                                    <span className="truncate text-[10px] text-on-surface-variant">FDA: {sug.product_name}</span>
                                    <button
                                      onClick={() => setFdaOverrides((m) => ({ ...m, [i]: sug.product_name.replace(/\s*\(.*\)\s*$/, "").trim() || sug.product_name }))}
                                      className="ml-auto shrink-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-on-primary"
                                    >
                                      Use
                                    </button>
                                  </div>
                                )}
                                {ov && <span className="ml-1 text-[10px] text-primary">(FDA)</span>}
                              </td>
                              <td className="px-3 py-1 font-data-mono text-data-mono text-on-surface-variant">{r.barcode ?? "—"}</td>
                              <td className="px-3 py-1 text-right font-data-mono text-data-mono">{r.stock_qty ?? 0}</td>
                              <td className="px-3 py-1 text-right font-data-mono text-data-mono">{r.selling_price != null ? `GH₵ ${r.selling_price}` : "—"}</td>
                              <td className="px-3 py-1 text-[11px] text-on-surface-variant">{sug ? sug.product_name.slice(0, 28) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {sheet && stats && stats.recs.length > 0 && (
                <div className="mb-3 flex items-center gap-2">
                  <button
                    onClick={async () => {
                      if (!sheet) return;
                      setBulkFdaBusy(true);
                      try {
                        // Check the FDA catalog is populated.
                        const { initDb } = await import("../db");
                        const d = await initDb();
                        const cnt = await d.select<{ n: number }[]>("SELECT COUNT(*) as n FROM fda_drugs", []);
                        if ((cnt[0]?.n ?? 0) === 0) {
                          setErr("FDA catalog is empty — update it first in Settings → FDA Ghana catalog.");
                          return;
                        }
                        let applied = 0;
                        for (let i = 0; i < sheet.rows.length; i++) {
                          const r = rowToRecord(sheet.rows[i], mapping);
                          const q = r?.name?.trim();
                          if (!q || q.length < 2 || fdaOverrides[i] !== undefined) continue;
                          try {
                            const res = await searchFdaDrugs(q, 1);
                            const top = res[0];
                            if (top && top.product_name.toLowerCase() !== q.toLowerCase()) {
                              const clean = top.product_name.replace(/\s*\(.*\)\s*$/, "").trim() || top.product_name;
                              setFdaOverrides((m) => ({ ...m, [i]: clean }));
                              applied++;
                              // Small pause to keep UI responsive for large files.
                              if (applied % 20 === 0) await new Promise((res) => setTimeout(res, 0));
                            }
                          } catch {
                            /* ignore per-row failures */
                          }
                        }
                        if (applied === 0) setErr("No FDA matches found for these names — they'll import as-is.");
                      } finally {
                        setBulkFdaBusy(false);
                      }
                    }}
                    disabled={bulkFdaBusy}
                    className="rounded border border-primary/40 bg-primary/5 px-3 py-1 text-label-md font-label-md text-primary hover:bg-primary/10 disabled:opacity-50"
                  >
                    {bulkFdaBusy ? "Checking FDA…" : "Apply FDA names where found (all rows)"}
                  </button>
                  {Object.keys(fdaOverrides).length > 0 && (
                    <button
                      onClick={() => setFdaOverrides({})}
                      className="rounded border border-outline-variant px-3 py-1 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                    >
                      Undo FDA names
                    </button>
                  )}
                </div>
              )}

              <p
                className={`mb-4 text-body-sm font-body-sm ${
                  stats.usable === 0 ? "text-error" : "text-on-surface"
                }`}
              >
                {stats.total} rows · {stats.created} new items · {stats.updated} will update
                (prices + quantity added)
                {stats.skip > 0 ? ` · ${stats.skip} skipped (no product name)` : ""}
              </p>
            </div>
          )}

          {phase === "done" && summary && (
            <div>
              <div className="mb-4 grid grid-cols-3 gap-3">
                <div className="rounded border border-outline-variant bg-surface-container-low p-3 text-center">
                  <p className="text-headline-lg font-headline-lg font-bold text-primary">
                    {summary.created}
                  </p>
                  <p className="text-label-md font-label-md text-on-surface-variant">Added</p>
                </div>
                <div className="rounded border border-outline-variant bg-surface-container-low p-3 text-center">
                  <p className="text-headline-lg font-headline-lg font-bold text-on-surface">
                    {summary.updated}
                  </p>
                  <p className="text-label-md font-label-md text-on-surface-variant">Updated</p>
                </div>
                <div className="rounded border border-outline-variant bg-surface-container-low p-3 text-center">
                  <p className="text-headline-lg font-headline-lg font-bold text-on-surface">
                    {summary.skipped}
                  </p>
                  <p className="text-label-md font-label-md text-on-surface-variant">Skipped</p>
                </div>
              </div>
              {summary.errors.length > 0 && (
                <div className="mb-4 rounded border border-error/30 bg-error/5 p-3">
                  <p className="mb-1 text-label-md font-label-md font-bold text-error">
                    Rows that need attention
                  </p>
                  <ul className="list-inside list-disc text-body-sm font-body-sm text-error">
                    {summary.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              {backupPath && (
                <p className="mb-4 text-body-sm font-body-sm text-on-surface-variant">
                  Backup taken before import: {backupPath}
                </p>
              )}
              <p className="text-body-sm font-body-sm text-on-surface-variant">
                Stock is live — check the list for anything that needs a price or
                category finished off.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-outline-variant bg-surface-container-lowest px-5 py-3">
          {phase === "pick" && (
            <button
              onClick={onClose}
              className="rounded border border-outline-variant px-4 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-container-low"
            >
              Close
            </button>
          )}
          {phase === "map" && stats && (
            <>
              <button
                onClick={() => {
                  setPhase("pick");
                  setSheet(null);
                  setArmed(false);
                }}
                className="rounded border border-outline-variant px-4 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-container-low"
              >
                Choose another file
              </button>
              <button
                onClick={onClose}
                className="rounded border border-outline-variant px-4 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-container-low"
              >
                Cancel
              </button>
              <button
                onClick={armImport}
                disabled={busy || stats.usable === 0}
                className={`flex h-9 items-center gap-2 rounded px-5 text-label-md font-label-md text-on-primary shadow-sm transition-colors disabled:opacity-50 ${
                  armed ? "bg-error hover:bg-error/90" : "bg-primary hover:bg-on-primary-fixed-variant"
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">upload</span>
                {busy
                  ? "Importing…"
                  : armed
                    ? "Tap again to confirm"
                    : `Import ${stats.created + stats.updated} items`}
              </button>
            </>
          )}
          {phase === "done" && (
            <button
              onClick={onClose}
              className="rounded bg-primary px-5 py-1.5 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const FIELDS: { key: keyof StockImportRow; label: string; aliases: string[] }[] = [
  { key: "name", label: "Product name", aliases: ["name", "product", "item", "description", "drug", "medicine", "drug name", "generic name", "product name", "item name", "name of medication", "medication", "particulars", "item description", "product description"] },
  { key: "barcode", label: "Barcode", aliases: ["barcode", "bar code", "code", "ean", "upc", "sku", "product code", "barcode id"] },
  { key: "selling_price", label: "Selling price", aliases: ["selling price", "price", "unit price", "retail price", "sale price", "selling", "base price", "sale price (base price)"] },
  { key: "cost_price", label: "Cost price", aliases: ["cost", "cost price", "buying price", "unit cost", "purchase price", "cogs"] },
  { key: "stock_qty", label: "Stock quantity", aliases: ["qty", "quantity", "stock", "stock qty", "balance", "on hand", "available", "current stock", "stock balance"] },
  { key: "reorder_level", label: "Reorder level", aliases: ["reorder", "reorder level", "min stock", "minimum", "reorder point", "min qty"] },
  { key: "pack_size", label: "Units per pack", aliases: ["pack size", "units per pack", "pack qty", "units in pack", "per pack", "pieces per pack"] },
  { key: "category", label: "Category", aliases: ["category", "class", "group", "therapeutic class", "medication type", "medication", "drug category"] },
  { key: "manufacturer", label: "Manufacturer", aliases: ["manufacturer", "maker", "brand", "company", "brand name"] },
  { key: "supplier", label: "Supplier", aliases: ["supplier", "vendor", "distributor", "supplier name", "vendor name"] },
  { key: "strength", label: "Strength / dosage", aliases: ["strength", "dosage", "dose", "formulation", "form", "dosage form"] },
  { key: "unit", label: "Unit / pack", aliases: ["unit", "uom", "pack", "package", "selling unit", "route", "form"] },
  { key: "batch_no", label: "Batch no.", aliases: ["batch", "batch no", "batch number", "lot", "lot no", "batch number"] },
  { key: "expiry_date", label: "Expiry date", aliases: ["expiry", "expiry date", "exp", "expiration", "exp date"] },
  { key: "fda_reg_no", label: "FDA reg. no.", aliases: ["fda", "fda reg", "reg no", "registration", "fda no", "fda registration"] },
  { key: "rx_flag", label: "Prescription (RX)", aliases: ["rx", "prescription", "rx flag"] },
  { key: "is_controlled", label: "Controlled drug", aliases: ["controlled", "controlled drug"] },
];

/** Two passes: exact header match first, then "contains" — a used column is
 * never claimed twice, so "Cost Price" won't also feed selling price. */
function autoMap(headers: string[]): Record<string, number> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const lower = headers.map((h) => norm(h));
  const used = new Set<number>();
  const mapping: Record<string, number> = {};
  for (const pass of [0, 1]) {
    for (const f of FIELDS) {
      if (mapping[f.key] !== undefined) continue;
      const idx = lower.findIndex((h, i) => {
        if (used.has(i)) return false;
        return f.aliases.some((a) => {
          const na = norm(a);
          return pass === 0 ? h === na : h === na || h.startsWith(`${na} `) || h.includes(na);
        });
      });
      if (idx >= 0) {
        mapping[f.key] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

/** Convert one raw row to a StockImportRow per the current mapping.
 * Returns null when the row has no product name (it would be skipped). */
function rowToRecord(row: string[], mapping: Record<string, number>): StockImportRow | null {
  const get = (key: string) => {
    const i = mapping[key];
    return i === undefined || i < 0 ? "" : (row[i] ?? "").trim();
  };
  const name = get("name");
  if (!name) return null;
  const num = (v: string): number | null => {
    if (!v) return null;
    const n = parseFloat(v.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const int = (v: string): number | null => {
    const n = num(v);
    return n === null ? null : Math.round(n);
  };
  const bool = (v: string): number | null => {
    if (!v) return null;
    return /^(1|yes|true|y|rx|controlled)$/i.test(v) ? 1 : 0;
  };
  const parseExpiry = (v: string): string | null => {
    if (!v) return null;
    const t = v.trim();
    // Excel serial: 5-6 digit integer (e.g. 46665 = 2027-10-09). 25569 = 1970-01-01.
    if (/^\d{4,6}(\.0+)?$/.test(t)) {
      const n = parseFloat(t);
      if (Number.isFinite(n) && n > 30000 && n < 60000) {
        const ms = Math.round((n - 25569) * 86400 * 1000);
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
    }
    // Already ISO or D/M/Y — normalize to YYYY-MM-DD.
    // Try YYYY-MM-DD or YYYY/MM/DD
    let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    // D/M/Y or D-M-Y
    m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return t || null;
  };
  return {
    name,
    barcode: get("barcode") || null,
    category: get("category") || null,
    manufacturer: get("manufacturer") || null,
    supplier: get("supplier") || null,
    strength: get("strength") || null,
    unit: get("unit") || null,
    rx_flag: bool(get("rx_flag")),
    batch_no: get("batch_no") || null,
    expiry_date: parseExpiry(get("expiry_date")),
    cost_price: num(get("cost_price")),
    selling_price: num(get("selling_price")),
    stock_qty: int(get("stock_qty")),
    reorder_level: int(get("reorder_level")),
    pack_size: int(get("pack_size")),
    fda_reg_no: get("fda_reg_no") || null,
    is_controlled: bool(get("is_controlled")),
  };
}
