import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { deleteOperator, saveOperator, saveSetting } from "../db";
import type { Operator } from "../db";
import { beep } from "../lib/audio";

export function SettingsPage() {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const taxRate = useStore((s) => s.taxRate);
  const operator = useStore((s) => s.operator);
  const operators = useStore((s) => s.operators);
  const receiptFooter = useStore((s) => s.receiptFooter);
  const autoOperator = useStore((s) => s.autoOperator);
  const applySettings = useStore((s) => s.applySettings);
  const setOperator = useStore((s) => s.setOperator);
  const loadOperators = useStore((s) => s.loadOperators);

  const [name, setName] = useState(pharmacyName);
  const [tax, setTax] = useState(String(taxRate));
  const [footer, setFooter] = useState(receiptFooter);
  const [saved, setSaved] = useState(false);

  const [rows, setRows] = useState<Operator[]>([]);
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [addErr, setAddErr] = useState("");
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  useEffect(() => {
    setRows(operators);
  }, [operators]);

  const save = async () => {
    await saveSetting("pharmacy_name", name.trim() || "Pulse Pharmacy");
    await saveSetting("tax_rate", tax.trim() || "0");
    await saveSetting("receipt_footer", footer.trim());
    applySettings({
      pharmacyName: name.trim() || "Pulse Pharmacy",
      taxRate: Number(tax) || 0,
      receiptFooter: footer.trim(),
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

        <button
          onClick={() => void save()}
          className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
        >
          <span className="text-label-md font-label-md">
            {saved ? "Saved ✓" : "Save receipt details"}
          </span>
        </button>
      </div>
    </div>
  );
}
