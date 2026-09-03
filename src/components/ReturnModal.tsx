import { useEffect, useState } from "react";
import { initDb, isManagerPinSet, returnSale } from "../db";
import type { ReturnResult } from "../db";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";
import { fmtMoney } from "../lib/money";

interface SaleRef {
  id: number;
  receipt_no: string;
  timestamp: string;
}

interface SaleItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  unit: string | null;
}

interface Props {
  sale: SaleRef;
  onClose(): void;
  /** Called after a successful return (refresh products + reports). */
  onDone(): void;
}

/** Refund part or all of a sale. The sale stays; stock goes back on the shelf. */
export function ReturnModal({ sale, onClose, onDone }: Props) {
  const operator = useStore((s) => s.operator);
  const currentUser = useStore((s) => s.currentUser);
  const pharmacyName = useStore((s) => s.pharmacyName);
  const [items, setItems] = useState<SaleItem[]>([]);
  const [alreadyReturned, setAlreadyReturned] = useState<Record<number, number>>({});
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [slip, setSlip] = useState<ReturnResult | null>(null);
  /** Manager PIN gate — required only when one is configured in Settings. */
  const [pinRequired, setPinRequired] = useState(false);
  const [managerPin, setManagerPin] = useState("");

  /** What's actually still returnable per product: sold minus already returned
   * on this sale — matches the Rust return_sale guard exactly. */
  const available = (productId: number, sold: number) =>
    Math.max(0, sold - (alreadyReturned[productId] ?? 0));

  useEffect(() => {
    void (async () => {
      try {
        setPinRequired(await isManagerPinSet());
      } catch {
        setPinRequired(false);
      }
      try {
        const db = await initDb();
        const rows = await db.select<SaleItem[]>(
          "SELECT product_id, product_name, quantity, unit_price, unit FROM sale_items WHERE sale_id = $1 ORDER BY id",
          [sale.id],
        );
        const prior = await db.select<{ product_id: number; qty: number }[]>(
          `SELECT sri.product_id AS product_id, SUM(sri.quantity) AS qty
           FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id
           WHERE sr.sale_id = $1 GROUP BY sri.product_id`,
          [sale.id],
        );
        setItems(rows);
        setAlreadyReturned(Object.fromEntries(prior.map((r) => [r.product_id, Number(r.qty)])));
        setQtys(
          Object.fromEntries(
            rows.map((r) => {
              const priorQty = prior.find((p) => p.product_id === r.product_id)?.qty ?? 0;
              return [r.product_id, String(Math.max(0, r.quantity - Number(priorQty)))];
            }),
          ),
        );
      } catch (e) {
        setErr(String(e).replace(/^Error: /, ""));
      }
    })();
  }, [sale.id]);

  const lines = items
    .map((it) => ({
      product_id: it.product_id,
      quantity: Math.min(
        Math.max(0, Math.floor(Number(qtys[it.product_id]) || 0)),
        available(it.product_id, it.quantity),
      ),
      unit_price: it.unit_price,
    }))
    .filter((l) => l.quantity > 0);
  const refundEstimate = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);

  const doReturn = async () => {
    if (lines.length === 0) {
      setErr("Pick at least one item to return.");
      beep(false);
      return;
    }
    if (pinRequired && managerPin.trim().length < 4) {
      setErr("Manager PIN required for refunds.");
      beep(false);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await returnSale(
        sale.id,
        lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
        reason.trim() || null,
        operator,
        managerPin.trim() || null,
        currentUser?.role ?? null,
      );
      beep(true);
      setSlip(r);
      onDone();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  if (slip) {
    return (
      <div
        data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface shadow-lg">
          <div id="receipt-area" className="p-6">
            <div className="text-center">
              <h3 className="text-headline-md font-headline-md font-bold text-on-surface">
                {pharmacyName}
              </h3>
              <p className="text-label-md font-label-md font-bold uppercase tracking-widest text-error">
                Return — {sale.receipt_no}
              </p>
              <p className="font-data-mono text-data-mono text-on-surface-variant">
                {new Date().toLocaleString()}
              </p>
            </div>
            <div className="my-4 border-t border-dashed border-outline-variant" />
            <div className="flex flex-col gap-1.5">
              {/* Rendered from `lines` (what was actually submitted and
                  accepted), not re-derived from raw input state, so the slip
                  can never show a different quantity than what was refunded. */}
              {lines.map((l) => {
                const it = items.find((i) => i.product_id === l.product_id);
                if (!it) return null;
                return (
                  <div key={l.product_id} className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-body-sm font-body-sm font-semibold text-on-surface">
                        {it.product_name}
                      </p>
                      <p className="font-data-mono text-data-mono text-on-surface-variant">
                        {it.unit ? `${it.unit} · ` : ""}
                        {l.quantity} × {fmtMoney(l.unit_price)}
                      </p>
                    </div>
                    <span className="shrink-0 font-data-mono text-data-mono text-error">
                      −{fmtMoney(l.quantity * l.unit_price)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="my-4 border-t border-dashed border-outline-variant" />
            <div className="flex justify-between font-data-mono text-data-mono">
              <span>Total refunded</span>
              <span className="font-bold text-error">−{fmtMoney(slip.total_refunded)}</span>
            </div>
            {reason.trim() && (
              <p className="mt-2 text-body-sm font-body-sm text-on-surface-variant">
                Reason: {reason.trim()}
              </p>
            )}
          </div>
          <div className="flex gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
            <button
              onClick={() => window.print()}
              className="flex flex-1 items-center justify-center gap-2 rounded border border-outline px-4 py-2 text-on-surface hover:bg-surface-variant"
            >
              <span className="material-symbols-outlined text-[18px]">print</span>
              <span className="text-label-md font-label-md">Print</span>
            </button>
            <button
              onClick={onClose}
              autoFocus
              className="flex-1 rounded bg-primary px-4 py-2 text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
            >
              <span className="text-label-md font-label-md">Done</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">
              Return — {sale.receipt_no}
            </h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              {sale.timestamp} · stock goes back on the shelf
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 && !err && (
            <p className="py-6 text-center text-body-sm text-on-surface-variant">Loading…</p>
          )}
          {items.map((it) => {
            const v = Number(qtys[it.product_id]) || 0;
            const max = available(it.product_id, it.quantity);
            const priorQty = alreadyReturned[it.product_id] ?? 0;
            return (
              <div
                key={it.product_id}
                className="flex items-center justify-between border-b border-outline-variant/50 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1 pr-3">
                  <p className="truncate text-body-md font-semibold text-on-surface">
                    {it.product_name}
                  </p>
                  <p className="font-data-mono text-data-mono text-on-surface-variant">
                    {fmtMoney(it.unit_price)} each · {it.quantity} sold
                    {priorQty > 0 ? ` · ${priorQty} already returned` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={max}
                    value={qtys[it.product_id] ?? ""}
                    onChange={(e) =>
                      setQtys((q) => ({ ...q, [it.product_id]: e.target.value }))
                    }
                    title={`Return how many (max ${max})`}
                    disabled={max === 0}
                    className="h-8 w-16 rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
                  />
                  <span className="w-20 text-right font-data-mono text-data-mono text-on-surface">
                    {v > 0 ? `−${fmtMoney(v * it.unit_price)}` : "—"}
                  </span>
                </div>
              </div>
            );
          })}
          {err && <p className="mt-3 text-body-sm text-error">{err}</p>}
        </div>

        <div className="border-t border-outline-variant bg-surface-container px-6 py-4">
          {pinRequired && (
            <label className="mb-3 block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Manager PIN — refunds are protected
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
          )}
          <label className="mb-3 block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Reason (optional)
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer changed mind, wrong item"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className="font-data-mono text-data-mono text-on-surface-variant">
              Refunding: <span className="font-bold text-error">−{fmtMoney(refundEstimate)}</span>
            </span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Cancel
              </button>
              <button
                onClick={() => void doReturn()}
                disabled={busy || lines.length === 0}
                className="rounded bg-error px-6 py-2 text-label-md font-label-md text-on-error shadow-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Refunding…" : "Refund & restock"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
