import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { deleteOperator, saveOperator, saveSetting, listBackups, restoreBackup, restartApp } from "../db";
import type { Operator, BackupInfo } from "../db";
import { beep } from "../lib/audio";

export function SettingsPage() {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const taxRate = useStore((s) => s.taxRate);
  const operator = useStore((s) => s.operator);
  const operators = useStore((s) => s.operators);
  const receiptFooter = useStore((s) => s.receiptFooter);
  const autoOperator = useStore((s) => s.autoOperator);
  const supportEmail = useStore((s) => s.supportEmail);
  const momoNumber = useStore((s) => s.momoNumber);
  const applySettings = useStore((s) => s.applySettings);
  const setOperator = useStore((s) => s.setOperator);
  const loadOperators = useStore((s) => s.loadOperators);

  const [name, setName] = useState(pharmacyName);
  const [tax, setTax] = useState(String(taxRate));
  const [footer, setFooter] = useState(receiptFooter);
  const [support, setSupport] = useState(supportEmail);
  const [momo, setMomo] = useState(momoNumber);
  const isDark = useStore((s) => s.isDark);
  const [saved, setSaved] = useState(false);

  const [rows, setRows] = useState<Operator[]>([]);
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [addErr, setAddErr] = useState("");
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupErr, setBackupErr] = useState("");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    setRows(operators);
  }, [operators]);

  const loadBackups = async () => {
    try {
      setBackups(await listBackups());
      setBackupErr("");
    } catch (e) {
      setBackupErr(String(e));
    }
  };
  useEffect(() => {
    void loadBackups();
  }, []);

  const fmtSize = (b: number) =>
    b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  const fmtDate = (epoch: number) =>
    epoch ? new Date(epoch * 1000).toLocaleString() : "—";

  /** Two-step restore: tap once to arm, again to run. Current DB is backed up first, then the app restarts. */
  const armRestore = (name: string) => {
    if (confirmRestore !== name) {
      setConfirmRestore(name);
      window.setTimeout(() => setConfirmRestore((c) => (c === name ? null : c)), 4000);
      return;
    }
    setConfirmRestore(null);
    setRestoring(true);
    void (async () => {
      try {
        await restoreBackup(name);
        beep(true);
        await restartApp(); // never resolves — the app relaunches
      } catch (e) {
        setBackupErr(String(e).replace(/^Error: /, ""));
        setRestoring(false);
        beep(false);
      }
    })();
  };

  const save = async () => {
    await saveSetting("pharmacy_name", name.trim() || "Pulse Pharmacy");
    await saveSetting("tax_rate", tax.trim() || "0");
    await saveSetting("receipt_footer", footer.trim());
    await saveSetting("support_email", support.trim());
    await saveSetting("momo_number", momo.trim());
    applySettings({
      pharmacyName: name.trim() || "Pulse Pharmacy",
      taxRate: Number(tax) || 0,
      receiptFooter: footer.trim(),
      supportEmail: support.trim(),
      momoNumber: momo.trim(),
    });
    beep(true);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addOperator = async () => {
    if (!newName.trim()) return;
    setAddErr("");
    try {
      await saveOperator({
        name: newName,
        shift_start: newStart || null,
        shift_end: newEnd || null,
      });
      setNewName("");
      setNewStart("");
      setNewEnd("");
      await loadOperators();
      beep(true);
    } catch {
      setAddErr("That name already exists.");
    }
  };

  const removeOperator = async (row: Operator) => {
    await deleteOperator(row.id);
    if (operator === row.name) setOperator("");
    await loadOperators();
    beep(true);
  };

  const toggleAuto = async (v: boolean) => {
    await saveSetting("auto_operator", v ? "1" : "0");
    applySettings({ autoOperator: v });
    beep(true);
  };

  const toggleDark = async () => {
    const next = !isDark;
    await saveSetting("is_dark", next ? "1" : "0");
    applySettings({ isDark: next });
  };

  const field =
    "h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-6">
        <h2 className="text-headline-lg font-headline-lg text-on-surface">Settings</h2>
        <p className="text-body-sm font-body-sm text-on-surface-variant">
          Receipt details and who works here. Saved locally.
        </p>
      </div>

      <div className="max-w-xl">
        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Pharmacy name
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Tax rate (%) — 0 disables the tax line
          </span>
          <input
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            inputMode="decimal"
            className={field}
          />
        </label>
        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Receipt footer
          </span>
          <input
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            className={field}
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Support email — where the Support page sends problem reports
          </span>
          <input
            value={support}
            onChange={(e) => setSupport(e.target.value)}
            type="email"
            placeholder="support@example.com"
            className={field}
          />
        </label>
        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Mobile Money number — shown on the payment screen and receipts so
            customers know where to pay
          </span>
          <input
            value={momo}
            onChange={(e) => setMomo(e.target.value)}
            placeholder="e.g. 024 000 0000"
            className={field}
          />
        </label>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <h3 className="mb-3 text-headline-md font-headline-md text-on-surface">Operators</h3>

          <label className="mb-4 block">
            <span className="mb-1 block text-body-md font-body-md text-on-surface">
              Who is on duty now (stamped on every sale)
            </span>
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              className={field}
            >
              <option value="">— No operator —</option>
              {operators.map((op) => (
                <option key={op.id} value={op.name}>
                  {op.name}
                  {op.shift_start && op.shift_end ? ` (${op.shift_start}–${op.shift_end})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoOperator}
              onChange={(e) => void toggleAuto(e.target.checked)}
              className="h-4 w-4 rounded border-outline text-primary focus:ring-primary"
            />
            <span className="text-body-md font-body-md text-on-surface">
              Auto-switch operator by shift times (optional)
            </span>
          </label>

          {rows.map((row) => (
            <div key={row.id} className="mb-2 flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center gap-2 rounded border border-outline-variant bg-surface-container-low px-3">
                <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                  badge
                </span>
                <span className="text-body-md font-body-md text-on-surface">{row.name}</span>
                {row.shift_start && row.shift_end ? (
                  <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 font-data-mono text-data-mono text-[11px] font-bold text-primary">
                    {row.shift_start}–{row.shift_end}
                  </span>
                ) : (
                  <span className="ml-auto text-[11px] text-on-surface-variant">no shift</span>
                )}
              </div>
              <button
                onClick={() => {
                  if (confirmDel !== row.id) {
                    setConfirmDel(row.id);
                    window.setTimeout(() => setConfirmDel((c) => (c === row.id ? null : c)), 2500);
                    return;
                  }
                  void removeOperator(row);
                }}
                title={
                  confirmDel === row.id
                    ? "Click again to remove"
                    : "Remove operator (past sales keep the name)"
                }
                className={`flex h-9 w-16 items-center justify-center gap-1 rounded text-label-md font-label-md transition-colors ${
                  confirmDel === row.id
                    ? "bg-error/10 text-error hover:bg-error/20"
                    : "text-outline hover:bg-error/10 hover:text-error"
                }`}
              >
                {confirmDel === row.id ? (
                  <>
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                    Remove?
                  </>
                ) : (
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                )}
              </button>
            </div>
          ))}

          <div className="mt-3 flex items-center gap-2 border-t border-outline-variant/50 pt-3">
            <input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setAddErr("");
              }}
              placeholder="New operator name"
              className="h-9 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none"
            />
            <input
              type="time"
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
              title="Shift start (optional)"
              className="h-9 w-28 rounded border border-outline-variant bg-surface-container-lowest px-2 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
            />
            <span className="text-on-surface-variant">–</span>
            <input
              type="time"
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
              title="Shift end (optional)"
              className="h-9 w-28 rounded border border-outline-variant bg-surface-container-lowest px-2 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
            />
            <button
              onClick={() => void addOperator()}
              disabled={!newName.trim()}
              className="h-9 rounded bg-primary px-4 text-label-md font-label-md text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {addErr && <p className="mt-2 text-body-sm text-error">{addErr}</p>}
          <p className="mt-2 text-body-sm text-on-surface-variant">
            Operators can't be edited after adding — delete and re-add to change
            a name or shift. Past sales keep the old name. Shift times are
            optional; with auto-switch on, the app swaps to the operator whose
            shift covers the current time (overnight shifts work).
          </p>
        </div>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-headline-md font-headline-md text-on-surface">Backups</h3>
            <button
              onClick={() => void loadBackups()}
              className="rounded border border-outline-variant px-2 py-1 text-label-md font-label-md text-on-surface-variant hover:bg-surface-variant"
            >
              Refresh
            </button>
          </div>
          <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
            Automatic backups run after every 10th sale, on app exit, and via
            the Reports page. The newest 20 are kept. Restoring swaps the
            database — the current data is backed up first, then the app
            restarts.
          </p>
          {backupErr && (
            <p className="mb-2 text-body-sm font-body-sm text-error">{backupErr}</p>
          )}
          {backups.length === 0 && !backupErr && (
            <p className="py-3 text-center text-body-sm text-on-surface-variant">
              No backups yet — hit Backup on the Reports page.
            </p>
          )}
          <div className="max-h-[240px] overflow-y-auto">
          {backups.slice(0, 10).map((b) => (
            <div key={b.name} className="flex items-center gap-2 border-b border-outline-variant/50 py-1.5 last:border-0">
              <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                database
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-data-mono text-data-mono text-on-surface">
                  {b.name}
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  {fmtSize(b.size)} · {fmtDate(b.modified)}
                </p>
              </div>
              <button
                onClick={() => armRestore(b.name)}
                disabled={restoring}
                title="Restore this backup — current data is saved first, app restarts"
                className={`h-8 w-20 shrink-0 rounded text-label-md font-label-md transition-colors disabled:opacity-50 ${
                  confirmRestore === b.name
                    ? "bg-error/10 text-error hover:bg-error/20"
                    : "border border-outline-variant text-on-surface hover:bg-surface-variant"
                }`}
              >
                {restoring && confirmRestore === b.name
                  ? "Restoring…"
                  : confirmRestore === b.name
                    ? "Restore?"
                    : "Restore"}
              </button>
            </div>
          ))}
          </div>
          {backups.length > 10 && (
            <p className="pt-2 text-[11px] text-on-surface-variant">
              +{backups.length - 10} older backups (kept, newest 20 shown)
            </p>
          )}
        </div>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <h3 className="mb-3 text-headline-md font-headline-md text-on-surface">Appearance</h3>
          <label className="flex items-center gap-3">
            <button
              onClick={() => void toggleDark()}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                isDark ? "bg-primary" : "bg-surface-variant"
              }`}
              role="switch"
              aria-checked={isDark}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  isDark ? "translate-x-5" : ""
                }`}
              />
            </button>
            <span className="text-body-md font-body-md text-on-surface">
              Dark mode
            </span>
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
              {isDark ? "dark_mode" : "light_mode"}
            </span>
          </label>
        </div>

        <button
          onClick={() => void save()}
          className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
        >
          <span className="text-label-md font-label-md">
            {saved ? "Saved ✓" : "Save"}
          </span>
        </button>
      </div>
    </div>
  );
}
