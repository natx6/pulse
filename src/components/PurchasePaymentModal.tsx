import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import { isManagerPinSet, recordPayment } from "../db";
import { beep } from "../lib/audio";
import type { Purchase } from "../db";

interface Props {
  p: Purchase;
  onClose(): void;
  onPaid(r: { reference_no: string | null; paid: number; balance: number }): Promise<void>;
}

const METHODS = ["Cash", "Mobile Money", "Bank Transfer", "Cheque"] as const;

/** Record a payment against a supplier invoice (the "what do I owe" ledger).
 * Money leaves the business — when a manager PIN is configured the field
 * appears and the backend refuses anything without it. */
export function PurchasePaymentModal({ p, onClose, onPaid }: Props) {
  const operator = useStore((s) => s.operator);
  const balance = Math.max(0, p.total_amount - p.paid_amount);

  const [amount, setAmount] = useState(String(balance));
  const [method, setMethod] = useState<string>("Cash");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** Manager PIN — required for payments when one is configured. */
  const [pinRequired, setPinRequired] = useState(false);
  const [managerPin, setManagerPin] = useState("");

  useEffect(() => {
    void isManagerPinSet().then(setPinRequired).catch(() => setPinRequired(false));
  }, []);

  const save = async () => {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) {
      setErr("Enter a positive amount.");
      return;
    }
    if (a > balance + 0.005) {
      setErr(`Can't exceed the ${fmtMoney(balance)} balance left on this invoice.`);
      return;
    }
    if (pinRequired && managerPin.trim().length < 4) {
      setErr("Manager PIN required to pay a supplier.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await recordPayment(p.id, a, method, operator || null, managerPin.trim() || null);
      beep(true);
      await onPaid(r);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "h-8 w-full rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

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
      <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">Record payment</h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              {p.reference_no ?? p.id} · {p.supplier_name ?? "No supplier"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="flex items-end justify-between rounded border border-outline-variant bg-surface-container-low px-3 py-2">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                Invoice total
              </p>
              <p className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(p.total_amount)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                Balance left
              </p>
              <p className="font-data-mono text-data-mono font-bold text-primary">
                {fmtMoney(balance)}
              </p>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">Amount</span>
            <input
              type="number"
              min={0}
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={`${inputCls} text-right font-data-mono text-data-mono`}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          {pinRequired && (
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-label-md font-label-md text-on-surface">
                <span className="material-symbols-outlined text-[16px]">shield</span>
                Manager PIN — supplier payments are protected
              </span>
              <input
                type="password"
                inputMode="numeric"
                value={managerPin}
                onChange={(e) => setManagerPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="••••"
                aria-label="Manager PIN"
                className={`${inputCls} w-40 text-center font-data-mono text-data-mono tracking-[0.3em]`}
              />
            </label>
          )}

          {err && <p className="text-body-sm text-error" role="alert">{err}</p>}
        </div>

        <div className="flex gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={onClose}
            className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">payments</span>
            {busy ? "Recording…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
