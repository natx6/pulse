import { useEffect, useState } from "react";
import { initDb, updatePatientDiscount, getPatientDiscount } from "../db";
import { fmtMoney } from "../lib/money";
import { ReceiptModal } from "./ReceiptModal";
import { beep } from "../lib/audio";
import type { CartLine, PaymentLine, PaymentMethod, SaleResult } from "../types";

interface Props {
  name: string;
  phone: string | null;
  onClose(): void;
}

interface Visit {
  id: number;
  receipt_no: string;
  total_amount: number;
  payment_method: string;
  timestamp: string;
}

/** A patient's purchase history: last 10 sales with reprint, plus a visits summary. */
export function PatientModal({ name, phone, onClose }: Props) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [totalVisits, setTotalVisits] = useState<number | null>(null);
  const [lastVisit, setLastVisit] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [discountSaved, setDiscountSaved] = useState(false);
  const [reprint, setReprint] = useState<{
    result: SaleResult;
    lines: CartLine[];
    subtotal: number;
    tax: number;
    /** Discount snapshot (migration 0024) so reprints explain subtotal > total. */
    discountPct?: number;
    discountAmt?: number;
    method: string;
    payments?: PaymentLine[];
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const db = await initDb();
        const rows = await db.select<Visit[]>(
          `SELECT id, receipt_no, total_amount, payment_method, timestamp FROM sales
           WHERE patient_name = $1 ORDER BY id DESC LIMIT 10`,
          [name],
        );
        setVisits(rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) })));
        const [sum] = await db.select<{ n: number; last: string | null }[]>(
          `SELECT COUNT(*) AS n, MAX(timestamp) AS last FROM sales WHERE patient_name = $1`,
          [name],
        );
        setTotalVisits(sum ? Number(sum.n) : 0);
        setLastVisit(sum?.last ?? null);
        const disc = await getPatientDiscount(name);
        setDiscountInput(disc > 0 ? String(disc) : "");
      } catch (e) {
        setErr(String(e).replace(/^Error: /, ""));
      }
    })();
  }, [name]);

  const saveDiscount = async () => {
    const v = Math.min(100, Math.max(0, Number(discountInput) || 0));
    setDiscountInput(v > 0 ? String(v) : "");
    try {
      await updatePatientDiscount(name, v);
      setErr("");
      setDiscountSaved(true);
      setTimeout(() => setDiscountSaved(false), 1500);
    } catch (e) {
      // A failed write must not show the success checkmark.
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  const doReprint = async (receiptNo: string) => {
    try {
      const db = await initDb();
      const [sale] = await db.select<
        { id: number; receipt_no: string; total_amount: number; payment_method: string;
          change_given: number | null; subtotal: number | null; discount_amount: number | null;
          tax_amount: number | null }[]
      >(`SELECT id, receipt_no, total_amount, payment_method,
                change_given, subtotal, discount_amount, tax_amount
         FROM sales WHERE receipt_no = $1`, [
        receiptNo,
      ]);
      if (!sale) return;
      const items = await db.select<
        { product_name: string; quantity: number; unit_price: number; unit: string | null }[]
      >("SELECT product_name, quantity, unit_price, unit FROM sale_items WHERE sale_id = $1", [
        sale.id,
      ]);
      const pays = await db.select<
        { method: string; amount: number; reference: string | null }[]
      >("SELECT method, amount, reference FROM sale_payments WHERE sale_id = $1 ORDER BY id", [
        sale.id,
      ]);
      // Stored snapshot (migration 0024); legacy fallback as in Reports. The
      // percent is re-derived from the stored amount — patient tiers are
      // whole numbers, so this recovers the original figure exactly.
      const sub = sale.subtotal !== null && Number(sale.subtotal) > 0 ? Number(sale.subtotal) : Number(sale.total_amount);
      const discountAmt = Number(sale.discount_amount ?? 0);
      const discountPct =
        discountAmt > 0 && sub > 0 ? Math.round((discountAmt / sub) * 100) : 0;
      setReprint({
        result: {
          receipt_no: sale.receipt_no,
          sale_id: sale.id,
          total: Number(sale.total_amount),
          change: Number(sale.change_given ?? 0),
        },
        lines: items.map((i) => ({
          productId: 0,
          name: i.product_name,
          unit: i.unit,
          unitPrice: Number(i.unit_price),
          qty: Number(i.quantity),
        })),
        subtotal: sub,
        tax: Number(sale.tax_amount ?? 0),
        discountPct,
        discountAmt,
        method: sale.payment_method,
        payments: pays.length
          ? pays.map((p) => ({
              method: p.method as PaymentMethod,
              amount: Number(p.amount),
              reference: p.reference,
            }))
          : undefined,
      });
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

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
            <h3 className="text-headline-md font-headline-md text-on-surface">{name}</h3>
            <p className="font-data-mono text-data-mono text-on-surface-variant">
              {phone || "No phone on file"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex gap-3 border-b border-outline-variant/50 px-6 py-3">
          <div className="flex-1 rounded border border-outline-variant/50 bg-surface-container-low p-2 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              Total visits
            </p>
            <p className="text-headline-md font-headline-md font-bold text-on-surface">
              {totalVisits ?? "…"}
            </p>
          </div>
          <div className="flex-1 rounded border border-outline-variant/50 bg-surface-container-low p-2 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              Last visit
            </p>
            <p className="pt-1 text-body-sm font-body-sm text-on-surface">
              {lastVisit ? new Date(lastVisit).toLocaleString() : "—"}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded border border-outline-variant/50 bg-surface-container-low px-3 py-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                Discount
              </p>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={discountInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || (Number(v) >= 0 && Number(v) <= 100)) setDiscountInput(v);
                  }}
                  placeholder="0"
                  className="h-7 w-12 rounded border border-outline-variant bg-surface-container-lowest px-1 text-center font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                />
                <span className="text-body-sm text-on-surface-variant">%</span>
                <button
                  onClick={() => void saveDiscount()}
                  className="h-7 rounded bg-primary/10 px-2 text-[10px] font-bold text-primary hover:bg-primary/20"
                >
                  {discountSaved ? "✓" : "Set"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {err && <p className="mb-2 text-body-sm text-error">{err}</p>}
          <h4 className="mb-2 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Last 10 sales (tap to reprint)
          </h4>
          {visits.length === 0 && (
            <p className="py-6 text-center text-body-sm text-on-surface-variant">
              No sales on record for this patient yet.
            </p>
          )}
          {visits.map((v) => (
            <button
              key={v.receipt_no}
              onClick={() => void doReprint(v.receipt_no)}
              className="flex w-full items-center justify-between border-b border-outline-variant/50 px-2 py-2 text-left transition-colors last:border-0 hover:bg-surface-container-low"
            >
              <span>
                <span className="block font-data-mono text-data-mono font-semibold text-on-surface">
                  {v.receipt_no}
                </span>
                <span className="text-[11px] text-on-surface-variant">
                  {v.payment_method} · {new Date(v.timestamp).toLocaleString()}
                </span>
              </span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(v.total_amount)}
              </span>
            </button>
          ))}
        </div>

        <div className="flex justify-end border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={onClose}
            autoFocus
            className="rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
          >
            Done
          </button>
        </div>
      </div>

      {reprint && (
        <ReceiptModal
          result={reprint.result}
          lines={reprint.lines}
          subtotal={reprint.subtotal}
          tax={reprint.tax}
          discountPct={reprint.discountPct}
          discountAmt={reprint.discountAmt}
          paymentMethod={reprint.method}
          payments={reprint.payments}
          onClose={() => setReprint(null)}
        />
      )}
    </div>
  );
}
