import { useCallback, useEffect, useMemo, useState } from "react";
import { initDb } from "../db";
import { fmtMoney } from "../lib/money";
import { DateField } from "../components/DateField";
import { ReceiptModal } from "../components/ReceiptModal";
import { ReturnModal } from "../components/ReturnModal";
import { useStore } from "../store/useStore";
import type { CartLine, PaymentLine, SaleResult } from "../types";

interface HistorySale {
  id: number;
  receipt_no: string;
  timestamp: string;
  operator: string | null;
  payment_method: string;
  total_amount: number;
  change_given: number;
  patient_name: string | null;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  refunded: number;
  paid: number;
}

interface SaleItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  unit: string | null;
}

interface SalePayment {
  method: string;
  amount: number;
  reference: string | null;
}

interface SaleReturn {
  id: number;
  total_refunded: number;
  reason: string | null;
  operator: string | null;
  timestamp: string;
  items: { product_name: string; quantity: number; unit_price: number; unit: string | null }[];
}

interface SaleDetail {
  items: SaleItem[];
  payments: SalePayment[];
  returns: SaleReturn[];
}

const METHODS = ["", "Cash", "Card", "MoMo", "Credit"];

type Range = "today" | "yesterday" | "week7" | "month30" | "month" | "custom";
const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week7", label: "Last 7 days" },
  { id: "month30", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rangeDates(r: Range, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  if (r === "today") return { from: fmt(now), to: fmt(now) };
  if (r === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { from: fmt(d), to: fmt(d) };
  }
  if (r === "week7") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { from: fmt(d), to: fmt(now) };
  }
  if (r === "month30") {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return { from: fmt(d), to: fmt(now) };
  }
  if (r === "month") {
    return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(now) };
  }
  return { from: customFrom || fmt(now), to: customTo || fmt(now) };
}

/** Point-of-sale history: a browseable, filterable log of every sale. Sales
 * are append-only (returns/voids are recorded separately, never deleted), so
 * this is a faithful audit trail — totals subtract refunds where relevant. */
export function HistoryPage() {
  const currentUser = useStore((s) => s.currentUser);
  const isWorker = currentUser?.role === "worker";
  const [range, setRange] = useState<Range>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("");
  const [rows, setRows] = useState<HistorySale[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<HistorySale | null>(null);
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [showReprint, setShowReprint] = useState(false);
  const [returnTarget, setReturnTarget] = useState<{ id: number; receipt_no: string; timestamp: string } | null>(null);

  const { from, to } = useMemo(
    () => rangeDates(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const d = await initDb();
      const like = search.trim() ? `%${search.trim()}%` : null;
      const data = await d.select<HistorySale[]>(
        `SELECT s.id, s.receipt_no, s.timestamp, s.operator, s.payment_method,
                s.total_amount, s.change_given, s.patient_name, s.subtotal,
                s.discount_amount, s.tax_amount,
                (SELECT COALESCE(SUM(total_refunded),0) FROM sale_returns r WHERE r.sale_id = s.id) AS refunded,
                (SELECT COALESCE(SUM(amount),0) FROM sale_payments sp WHERE sp.sale_id = s.id) AS paid
         FROM sales s
         WHERE date(s.timestamp) BETWEEN $1 AND $2
           AND (s.payment_method = $3 OR $3 IS NULL OR $3 = '')
           AND (s.receipt_no LIKE $4 OR s.operator LIKE $4 OR s.patient_name LIKE $4 OR $4 IS NULL)
         ORDER BY s.timestamp DESC
         LIMIT 300`,
        [from, to, method || null, like],
      );
      setRows(
        data.map((r) => ({
          ...r,
          total_amount: Number(r.total_amount),
          change_given: Number(r.change_given),
          subtotal: Number(r.subtotal),
          discount_amount: Number(r.discount_amount),
          tax_amount: Number(r.tax_amount),
          refunded: Number(r.refunded),
          paid: Number(r.paid),
        })),
      );
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
    } finally {
      setLoading(false);
    }
  }, [from, to, search, method]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (sale: HistorySale) => {
    setSelected(sale);
    setDetail(null);
    setDetailErr("");
    try {
      const d = await initDb();
      const [items, payments, returns] = await Promise.all([
        d.select<SaleItem[]>(
          `SELECT product_id, product_name, quantity, unit_price, unit
           FROM sale_items WHERE sale_id = $1 ORDER BY id`,
          [sale.id],
        ),
        d.select<SalePayment[]>(
          `SELECT method, amount, reference FROM sale_payments WHERE sale_id = $1 ORDER BY id`,
          [sale.id],
        ),
        d.select<{ id: number; total_refunded: number; reason: string | null; operator: string | null; timestamp: string }[]>(
          `SELECT id, total_refunded, reason, operator, timestamp
           FROM sale_returns WHERE sale_id = $1 ORDER BY id`,
          [sale.id],
        ),
      ]);
      const returnDetails: SaleReturn[] = await Promise.all(
        returns.map(async (r) => {
          const items = await d.select<{ product_name: string; quantity: number; unit_price: number; unit: string | null }[]>(
            `SELECT product_name, quantity, unit_price, unit FROM sale_return_items WHERE return_id = $1 ORDER BY id`,
            [r.id],
          );
          return { ...r, items };
        }),
      );
      setDetail({
        items: items.map((i) => ({ ...i, unit_price: Number(i.unit_price), quantity: Number(i.quantity) })),
        payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
        returns: returnDetails.map((r) => ({ ...r, total_refunded: Number(r.total_refunded) })),
      });
    } catch (e) {
      setDetailErr(String(e).replace(/^Error: /, ""));
    }
  }, []);

  const totals = useMemo(() => {
    const gross = rows.reduce((s, r) => s + r.total_amount, 0);
    const refunded = rows.reduce((s, r) => s + r.refunded, 0);
    return { count: rows.length, gross, refunded, net: gross - refunded };
  }, [rows]);

  const reprintLines: CartLine[] = useMemo(() => {
    if (!detail) return [];
    return detail.items.map((i) => ({
      productId: i.product_id,
      name: i.product_name,
      unit: i.unit,
      unitPrice: i.unit_price,
      qty: i.quantity,
    }));
  }, [detail]);

  const reprintResult: SaleResult | null = useMemo(() => {
    if (!selected) return null;
    return {
      receipt_no: selected.receipt_no,
      sale_id: selected.id,
      total: selected.total_amount,
      change: selected.change_given,
    };
  }, [selected]);

  const reprintPayments: PaymentLine[] = useMemo(
    () => (detail ? detail.payments.map((p) => ({ method: p.method as PaymentLine["method"], amount: p.amount, reference: p.reference })) : []),
    [detail],
  );

  const discountPct = selected && selected.subtotal > 0
    ? Math.round((selected.discount_amount / selected.subtotal) * 100)
    : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-outline-variant px-gutter py-density-medium">
        <div>
          <h2 className="text-headline-md font-headline-md text-on-surface">Sales history</h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">
            {totals.count} sales · {fmtMoney(totals.gross)} gross · {fmtMoney(totals.refunded)} refunded ·{" "}
            <span className="font-semibold text-on-surface">{fmtMoney(totals.net)} net</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-outline-variant px-gutter py-density-medium" data-tour="tour-history">
        <label className="flex flex-col gap-1">
          <span className="text-label-sm font-label-sm text-on-surface-variant">Period</span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
            className="h-8 rounded border border-outline-variant bg-surface px-2 text-label-md font-label-md text-on-surface focus:border-primary focus:outline-none"
          >
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {range === "custom" && (
          <>
            <DateField value={customFrom} onChange={setCustomFrom} className="h-8" />
            <span className="pb-1.5 text-on-surface-variant">→</span>
            <DateField value={customTo} onChange={setCustomTo} className="h-8" />
          </>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-label-sm font-label-sm text-on-surface-variant">Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="h-8 rounded border border-outline-variant bg-surface px-2 text-label-md font-label-md text-on-surface focus:border-primary focus:outline-none"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m || "All"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 min-w-[180px]">
          <span className="text-label-sm font-label-sm text-on-surface-variant">Search</span>
          <input
            type="text"
            placeholder="Receipt, operator or patient"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded border border-outline-variant bg-surface px-2 py-1.5 text-body-sm text-on-surface focus:border-primary focus:outline-none"
          />
        </label>
        <button
          onClick={() => {
            setRange("today");
            setCustomFrom("");
            setCustomTo("");
            setMethod("");
            setSearch("");
          }}
          className="rounded border border-outline px-3 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
        >
          Clear
        </button>
      </div>

      {err && <p className="px-gutter py-2 text-body-sm text-error">{err}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-body-sm">
          <thead className="sticky top-0 bg-surface-container-low text-label-sm font-label-sm uppercase tracking-wider text-on-surface-variant">
            <tr>
              <th className="px-4 py-2 text-left">Receipt</th>
              <th className="px-4 py-2 text-left">Time</th>
              <th className="px-4 py-2 text-left">Operator</th>
              <th className="px-4 py-2 text-left">Patient</th>
              <th className="px-4 py-2 text-left">Method</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2 text-right">Refunded</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const active = selected?.id === r.id;
              return (
                <tr
                  key={r.id}
                  onClick={() => void loadDetail(r)}
                  className={`cursor-pointer border-b border-outline-variant ${
                    active ? "bg-primary/10" : "hover:bg-surface-container-low"
                  }`}
                >
                  <td className="px-4 py-2 font-data-mono text-data-mono text-on-surface">{r.receipt_no}</td>
                  <td className="px-4 py-2 font-data-mono text-data-mono text-on-surface-variant">{r.timestamp}</td>
                  <td className="px-4 py-2 text-on-surface">{r.operator || "—"}</td>
                  <td className="px-4 py-2 text-on-surface">{r.patient_name || "—"}</td>
                  <td className="px-4 py-2 text-on-surface-variant">{r.payment_method}</td>
                  <td className="px-4 py-2 text-right font-data-mono text-data-mono text-on-surface">{fmtMoney(r.total_amount)}</td>
                  <td className="px-4 py-2 text-right font-data-mono text-data-mono text-error">
                    {r.refunded > 0 ? `−${fmtMoney(r.refunded)}` : "—"}
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-on-surface-variant">
                  No sales match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <p className="px-4 py-6 text-center text-on-surface-variant">Loading…</p>}
      </div>

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end bg-on-background/30" onClick={() => setSelected(null)}>
          <div
            className="flex h-full w-full max-w-md flex-col bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
              <div>
                <p className="font-data-mono text-data-mono text-on-surface">{selected.receipt_no}</p>
                <p className="text-body-sm text-on-surface-variant">{selected.timestamp}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-on-surface-variant hover:text-on-surface">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {detailErr && <p className="text-body-sm text-error">{detailErr}</p>}
              {!detail && !detailErr && <p className="text-body-sm text-on-surface-variant">Loading…</p>}
              {detail && (
                <div className="flex flex-col gap-4">
                  <section>
                    <h4 className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                      Items
                    </h4>
                    <div className="flex flex-col gap-1">
                      {detail.items.map((i, idx) => (
                        <div key={idx} className="flex justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-body-sm font-semibold text-on-surface">{i.product_name}</p>
                            <p className="font-data-mono text-data-mono text-on-surface-variant">
                              {i.unit ? `${i.unit} · ` : ""}
                              {i.quantity} × {fmtMoney(i.unit_price)}
                            </p>
                          </div>
                          <span className="shrink-0 font-data-mono text-data-mono text-on-surface">
                            {fmtMoney(i.quantity * i.unit_price)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-col gap-0.5 border-t border-outline-variant pt-2 font-data-mono text-data-mono">
                      <div className="flex justify-between text-on-surface-variant">
                        <span>Subtotal</span>
                        <span>{fmtMoney(selected.subtotal)}</span>
                      </div>
                      {selected.discount_amount > 0 && (
                        <div className="flex justify-between text-primary">
                          <span>Discount ({discountPct}%)</span>
                          <span>−{fmtMoney(selected.discount_amount)}</span>
                        </div>
                      )}
                      {selected.tax_amount > 0 && (
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Tax</span>
                          <span>{fmtMoney(selected.tax_amount)}</span>
                        </div>
                      )}
                      <div className="flex justify-between pt-1 font-bold">
                        <span>Total</span>
                        <span>{fmtMoney(selected.total_amount)}</span>
                      </div>
                      {selected.change_given > 0 && (
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Change</span>
                          <span>{fmtMoney(selected.change_given)}</span>
                        </div>
                      )}
                    </div>
                  </section>

                  <section>
                    <h4 className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                      Payments
                    </h4>
                    <div className="flex flex-col gap-0.5">
                      {detail.payments.map((p, idx) => (
                        <div key={idx} className="flex justify-between text-body-sm text-on-surface">
                          <span>
                            {p.method}
                            {p.reference ? ` · ${p.reference}` : ""}
                          </span>
                          <span className="font-data-mono text-data-mono">{fmtMoney(p.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  {detail.returns.length > 0 && (
                    <section>
                      <h4 className="mb-1 text-label-md font-label-md uppercase tracking-wider text-error">
                        Refunds
                      </h4>
                      <div className="flex flex-col gap-2">
                        {detail.returns.map((r) => (
                          <div key={r.id} className="rounded border border-error/30 bg-error-container px-3 py-2">
                            <div className="flex justify-between text-body-sm text-on-error-container">
                              <span>{r.timestamp}</span>
                              <span className="font-data-mono text-data-mono">−{fmtMoney(r.total_refunded)}</span>
                            </div>
                            {r.reason && <p className="text-body-sm text-on-error-container">{r.reason}</p>}
                            {r.items.map((ri, i) => (
                              <p key={i} className="text-body-sm text-on-error-container/80">
                                {ri.quantity} × {ri.product_name}
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2 border-t border-outline-variant p-4">
              <button
                disabled={!reprintResult || !detail}
                onClick={() => setShowReprint(true)}
                className="flex flex-1 items-center justify-center gap-2 rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                Reprint
              </button>
              {!isWorker && (
                <button
                  disabled={!selected || !detail}
                  onClick={() =>
                    selected &&
                    setReturnTarget({ id: selected.id, receipt_no: selected.receipt_no, timestamp: selected.timestamp })
                  }
                  className="flex flex-1 items-center justify-center gap-2 rounded bg-error px-4 py-2 text-label-md font-label-md text-on-error hover:opacity-90 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">assignment_return</span>
                  Refund
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showReprint && reprintResult && (
        <ReceiptModal
          result={reprintResult}
          lines={reprintLines}
          subtotal={selected!.subtotal}
          discountPct={discountPct}
          discountAmt={selected!.discount_amount}
          tax={selected!.tax_amount}
          paymentMethod={selected!.payment_method}
          payments={reprintPayments}
          onClose={() => setShowReprint(false)}
        />
      )}

      {returnTarget && (
        <ReturnModal
          sale={returnTarget}
          onClose={() => setReturnTarget(null)}
          onDone={() => {
            setReturnTarget(null);
            void load();
            if (selected) void loadDetail(selected);
            void useStore.getState().refreshProducts();
          }}
        />
      )}
    </div>
  );
}
