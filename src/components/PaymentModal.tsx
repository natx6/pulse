import { useEffect, useState } from "react";
import type { CartLine, PaymentLine, PaymentMethod, SaleResult } from "../types";
import { completeSale } from "../db";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";
import { fmtMoney } from "../lib/money";
import { Tip } from "./Tip";

interface Props {
  total: number;
  lines: CartLine[];
  initialMethod?: PaymentMethod;
  onClose(): void;
  onComplete(r: SaleResult, payments: PaymentLine[]): void;
}

const METHODS: { id: PaymentMethod; icon: string; label: string; key: string }[] = [
  { id: "Cash", icon: "payments", label: "Cash", key: "F9" },
  { id: "Card", icon: "credit_card", label: "Card", key: "F10" },
  { id: "MoMo", icon: "send_to_mobile", label: "Mobile Money", key: "F11" },
  { id: "Credit", icon: "book", label: "Book", key: "" },
];

const QUICK_TENDER = [20, 50, 100, 200];
const round2 = (n: number) => Math.round(n * 100) / 100;

interface SplitRow {
  method: PaymentMethod;
  amount: string;
  reference: string;
}

export function PaymentModal({ total, lines, initialMethod, onClose, onComplete }: Props) {
  const operator = useStore((s) => s.operator);
  const patient = useStore((s) => s.patient);
  const momoNumber = useStore((s) => s.momoNumber);
  const [method, setMethod] = useState<PaymentMethod>(initialMethod ?? "Cash");
  const [tendered, setTendered] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [reference, setReference] = useState("");
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<SplitRow[]>(
    METHODS.map((m) => ({ method: m.id, amount: "", reference: "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Cash defaults to Exact: tendered = total, no extra click to complete.
  useEffect(() => {
    if (!split && method === "Cash" && tendered === null) setTendered(total);
  }, [method, tendered, total, split]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (split) return; // in split mode the method grid is an editor, not a picker
      if (e.key === "F9") setMethod("Cash");
      if (e.key === "F10") setMethod("Card");
      if (e.key === "F11") setMethod("MoMo");
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") void confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, tendered, custom, busy, split]);

  const change = tendered !== null ? Math.max(0, tendered - total) : 0;

  const splitPaid = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const splitRemaining = round2(total - splitPaid);

  const setRow = (i: number, patch: Partial<SplitRow>) => {
    setRows((rs) => {
      const next = rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      // Auto-fill: when exactly one row is still empty, put the remainder there.
      const empty = next.filter((r) => !r.amount);
      if (empty.length === 1 && splitPaid < total) {
        const idx = next.indexOf(empty[0]);
        if (patch.amount !== undefined || idx !== i) {
          next[idx] = { ...next[idx], amount: splitRemaining > 0 ? String(splitRemaining) : "" };
        }
      }
      return next;
    });
  };

  const confirm = async () => {
    if (busy) return;
    let payments: PaymentLine[];
    if (split) {
      const ps = rows
        .filter((r) => Number(r.amount) > 0)
        .map((r) => ({
          method: r.method,
          amount: round2(Number(r.amount)),
          reference: r.reference.trim() || null,
        }));
      if (ps.length === 0) {
        setError("Enter at least one payment amount.");
        beep(false);
        return;
      }
      if (ps.reduce((s, p) => s + p.amount, 0) < total - 0.005) {
        setError(`Payments (${fmtMoney(splitPaid)}) don't cover ${fmtMoney(total)}.`);
        beep(false);
        return;
      }
      payments = ps;
    } else {
      if (method === "Cash" && (tendered === null || tendered < total)) {
        setError("Enter an amount at least the total.");
        beep(false);
        return;
      }
      payments = [
        {
          method,
          amount: method === "Cash" ? (tendered ?? total) : total,
          reference: reference.trim() || null,
        },
      ];
    }
    // Book (credit) must be tied to a customer — the ledger needs a name.
    if (payments.some((p) => p.method === "Credit") && !patient?.name?.trim()) {
      setError("Book (credit) needs a customer name — attach one at the counter.");
      beep(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await completeSale(
        lines.map((l) => ({
          product_id: l.productId,
          name: l.name,
          quantity: l.qty,
          unit_price: l.unitPrice,
          unit: l.unit,
        })),
        payments,
        operator,
        patient,
      );
      beep(true);
      onComplete(result, payments);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const splitChange = Math.max(0, splitPaid - total);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <h3 className="text-headline-md font-headline-md text-on-surface">
            Payment — {fmtMoney(total)}
          </h3>
          <button
            onClick={() => setSplit(!split)}
            className={`rounded px-2 py-1 text-label-md font-label-md transition-colors ${
              split
                ? "bg-primary text-on-primary"
                : "border border-outline-variant text-on-surface-variant hover:bg-surface-variant"
            }`}
            title={split ? "Split is on — amounts below" : "Pay with more than one method"}
          >
            {split ? "Split ON" : "Split"}
          </button>
        </div>
        <div className="flex flex-col gap-4 p-6">
          {split ? (
            <div className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <div key={r.method} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-label-md font-label-md text-on-surface">
                    {r.method}
                  </span>
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                    {METHODS[i].icon}
                  </span>
                  <input
                    inputMode="decimal"
                    value={r.amount}
                    onChange={(e) => setRow(i, { amount: e.target.value })}
                    placeholder="0.00"
                    className="h-9 w-24 rounded border border-outline-variant bg-surface-container-lowest px-2 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                  />
                  <input
                    value={r.reference}
                    onChange={(e) => setRow(i, { reference: e.target.value })}
                    placeholder={r.method === "Cash" ? "Ref (optional)" : "Transaction ref (optional)"}
                    className="h-9 min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <span className="text-body-sm text-on-surface-variant">
                  {splitRemaining > 0.005 ? (
                    <>Still to cover: <span className="font-bold text-error">{fmtMoney(splitRemaining)}</span></>
                  ) : (
                    "Covered."
                  )}
                </span>
                {splitChange > 0.005 && (
                  <span className="text-body-sm font-bold text-primary">
                    Change {fmtMoney(splitChange)}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {METHODS.map((m) => {
                  const active = method === m.id;
                  return (
                    <Tip key={m.id} label={`${m.label} (${m.key})`}>
                      <button
                        onClick={() => setMethod(m.id)}
                        className={`flex w-full flex-col items-center gap-1 rounded py-2 transition-all active:scale-95 ${
                          active
                            ? "bg-primary text-on-primary shadow-sm"
                            : "border border-outline-variant bg-surface text-on-surface hover:bg-surface-variant"
                        }`}
                      >
                        <span className="material-symbols-outlined">{m.icon}</span>
                        <span className="text-[11px] font-bold">{m.label}</span>
                        <span
                          className={`mt-0.5 rounded px-1 text-[9px] ${
                            active ? "bg-black/20" : "bg-surface-container border border-outline-variant/50"
                          }`}
                        >
                          {m.key}
                        </span>
                      </button>
                    </Tip>
                  );
                })}
              </div>

              {method === "Cash" && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setTendered(total)}
                      className={`rounded px-3 py-1.5 text-label-md font-label-md transition-colors ${
                        tendered !== null && Math.abs(tendered - total) < 0.005
                          ? "bg-primary text-on-primary"
                          : "border border-primary bg-primary/10 text-primary hover:bg-primary/20"
                      }`}
                    >
                      Exact
                    </button>
                    {QUICK_TENDER.map((t) => (
                      <button
                        key={t}
                        onClick={() => setTendered(t)}
                        className={`rounded px-3 py-1.5 text-label-md font-label-md transition-colors ${
                          tendered === t
                            ? "bg-primary text-on-primary"
                            : "border border-outline-variant text-on-surface hover:bg-surface-variant"
                        }`}
                      >
                        GH₵ {t}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={custom}
                      onChange={(e) => {
                        setCustom(e.target.value);
                        const v = Number(e.target.value);
                        if (v > 0) setTendered(v);
                      }}
                      inputMode="decimal"
                      placeholder="Other amount"
                      className="h-9 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-3 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                    />
                    <div className="min-w-[8rem] text-right">
                      <span className="block text-[10px] uppercase tracking-wider text-on-surface-variant">
                        Change
                      </span>
                      <span
                        className={`font-data-mono text-data-mono font-bold ${
                          change > 0 ? "text-primary" : "text-on-surface-variant"
                        }`}
                      >
                        {fmtMoney(change)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {method === "Credit" && (
                <div className="rounded border border-[#b45309]/40 bg-[#fef08a]/20 px-3 py-2 text-body-sm text-[#854d0e]">
                  {patient?.name?.trim()
                    ? `On the book for ${patient.name.trim()} — you can settle it later under Reports → Customer credit.`
                    : "Put it on a customer's book — attach a customer name at the counter first."}
                </div>
              )}

              {method === "MoMo" && momoNumber && (
                <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm text-primary">
                  Customer pays to Mobile Money{" "}
                  <span className="font-bold">{momoNumber}</span> — enter their payment ID below.
                </div>
              )}

              {method !== "Cash" && method !== "Credit" && (
                <label className="block">
                  <span className="mb-1 block text-label-md font-label-md text-on-surface">
                    Transaction reference {method === "MoMo" ? "(MoMo ID)" : ""} — optional
                  </span>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder={
                      method === "MoMo"
                        ? "e.g. 506184912643"
                        : "e.g. last 4 digits of card"
                    }
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
              )}
            </>
          )}

          {error && <p className="text-body-sm font-body-sm text-error">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="rounded border border-outline px-4 py-2 text-on-surface hover:bg-surface-variant"
            >
              <span className="text-label-md font-label-md">Cancel</span>
            </button>
            <button
              onClick={() => void confirm()}
              disabled={
                busy ||
                (!split && method === "Cash" && (tendered ?? 0) < total) ||
                (split && rows.every((r) => !r.amount))
              }
              className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              <span className="text-label-md font-label-md">
                {busy
                  ? "Processing…"
                  : split
                    ? `Take ${fmtMoney(splitPaid)}`
                    : method === "Cash"
                      ? `Take ${fmtMoney(tendered ?? 0)}`
                      : method === "Credit"
                        ? `Put on book`
                        : `Charge ${fmtMoney(total)}`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
