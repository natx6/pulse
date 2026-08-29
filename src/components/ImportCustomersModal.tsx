import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { backupDb, commitCustomerImport, parseCustomerFile } from "../db";
import type { CustomerImportRow, ImportSummary, ParsedSheet } from "../db";
import { beep } from "../lib/audio";

/** Bulk-load customers from an Excel/CSV export of the old system: pick file →
 * auto-map columns → preview → confirm → commit in one transaction (with a
 * backup snapshot taken first). Opening balances flow into patients.opening_balance
 * so a customer's carry-over debt is right there in the credit ledger. */
export function ImportCustomersModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<"pick" | "map" | "done">("pick");
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [backupPath, setBackupPath] = useState("");

  const pickFile = async () => {
    setErr("");
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: "Customer export", extensions: ["xlsx", "xls", "ods", "csv"] }],
      });
      if (!file || typeof file !== "string") return;
      setFileName(file.split(/[\\/]/).pop() ?? file);
      const s = await parseCustomerFile(file);
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
    const recs: CustomerImportRow[] = [];
    let skip = 0;
    for (const row of sheet.rows) {
      const r = rowToRecord(row, mapping);
      if (!r) {
        skip++;
        continue;
      }
      recs.push(r);
    }
    return { total: sheet.rows.length, usable: recs.length, skip, recs };
  }, [sheet, mapping]);

  const doImport = async () => {
    if (!stats || stats.recs.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      const bpath = await backupDb();
      const res = await commitCustomerImport(stats.recs);
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

  const preview = sheet
    ? sheet.rows.slice(0, 5).map((row) => rowToRecord(row, mapping))
    : [];

  return (
    <div
      data-modal-open
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant px-5 py-3">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">Import Customers</h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              Bring over your old system's customer list and what they owe.
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
                <span className="text-body-md font-body-md">Choose the file from your old system</span>
                <span className="text-body-sm font-body-sm text-on-surface-variant">
                  Excel (.xlsx, .xls) or CSV — up to 5,000 rows
                </span>
              </button>
              <p className="mt-4 text-body-sm font-body-sm text-on-surface-variant">
                Everything lands in one transaction. Matching customers (by name) get their phone,
                discount tier, and opening balance refreshed; new ones are created. A backup is taken
                automatically before the import. We import the <em>current</em> position — not old sales
                history.
              </p>
            </div>
          )}

          {phase === "map" && sheet && stats && (
            <div>
              <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
                {fileName} — check that each column maps to the right field. Anything left as "— ignore
                —" stays blank.
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

              {preview.length > 0 && (
                <div className="mb-4 overflow-clip rounded border border-outline-variant">
                  <p className="border-b border-outline-variant bg-surface-container-low px-3 py-1.5 text-label-md font-label-md font-bold text-on-surface">
                    First rows as they'll be read
                  </p>
                  <div className="divide-y divide-outline-variant/50">
                    {preview.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-3 px-3 py-1 text-body-sm text-on-surface"
                      >
                        <span className="truncate">{r?.name ?? "— no name —"}</span>
                        <span className="shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                          {r?.phone ?? "no phone"} ·{" "}
                          {r?.opening_balance != null && r.opening_balance > 0
                            ? `owes GH₵ ${r.opening_balance}`
                            : "no balance"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p
                className={`mb-4 text-body-sm font-body-sm ${
                  stats.usable === 0 ? "text-error" : "text-on-surface"
                }`}
              >
                {stats.total} rows · {stats.usable} will import
                {stats.skip > 0 ? ` · ${stats.skip} skipped (no name)` : ""}
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
                Customers are live — open one to settle an opening balance or edit their discount.
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
                    : `Import ${stats.usable} customers`}
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

const FIELDS: { key: keyof CustomerImportRow; label: string; aliases: string[] }[] = [
  { key: "name", label: "Customer / patient name", aliases: ["name", "customer", "patient", "client", "customer name", "patient name", "client name", "full name", "contact name"] },
  { key: "phone", label: "Phone", aliases: ["phone", "mobile", "tel", "telephone", "contact", "cell", "msisdn", "number"] },
  { key: "discount_tier", label: "Discount %", aliases: ["discount", "discount %", "discount tier", "loyalty", "discount percent", "discount %"] },
  { key: "opening_balance", label: "Opening balance owed", aliases: ["balance", "owed", "credit", "opening", "opening balance", "amount owed", "arrears", "outstanding", "credit balance", "balance owed"] },
];

/** Two passes: exact header match first, then "contains" — a used column is
 * never claimed twice, so "Balance" won't also feed discount. */
function autoMap(headers: string[]): Record<string, number> {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const used = new Set<number>();
  const mapping: Record<string, number> = {};
  for (const pass of [0, 1]) {
    for (const f of FIELDS) {
      if (mapping[f.key] !== undefined) continue;
      const idx = lower.findIndex((h, i) => {
        if (used.has(i)) return false;
        return pass === 0
          ? f.aliases.some((a) => h === a)
          : f.aliases.some((a) => h.startsWith(`${a} `) || h.includes(a));
      });
      if (idx >= 0) {
        mapping[f.key] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

/** Convert one raw row to a CustomerImportRow per the current mapping.
 * Returns null when the row has no name (it would be skipped). */
function rowToRecord(row: string[], mapping: Record<string, number>): CustomerImportRow | null {
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
  return {
    name,
    phone: get("phone") || null,
    discount_tier: num(get("discount_tier")),
    opening_balance: num(get("opening_balance")),
  };
}
