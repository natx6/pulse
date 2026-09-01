import { useCallback, useEffect, useState } from "react";
import { initDb } from "../db";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";

interface Snapshot {
  gross: number;
  refunded: number;
  txns: number;
  itemsSold: number;
  cashIn: number;
  cardIn: number;
  momoIn: number;
  creditIn: number;
  openingFloat: number | null;
  cashExpenses: number;
  outOfStock: number;
  lowStock: number;
  expiringSoon: number;
  expired: number;
  openOrders: number;
  recent: { receipt_no: string; timestamp: string; total_amount: number; payment_method: string }[];
}

const TODAY = "date(s.timestamp) = date('now', 'localtime')";

/** Launch page: a glanceable "where do we stand right now" — today's takings,
 * what should be in the till, and everything shouting for attention (stock,
 * expiry, open orders). One tap drops into POS; nothing here blocks selling. */
export function DashboardPage() {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const operator = useStore((s) => s.operator);
  const setPage = useStore((s) => s.setPage);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await initDb();
      const [totals] = await d.select<{ gross: number; txns: number }[]>(
        `SELECT COALESCE(SUM(total_amount),0) AS gross, COUNT(*) AS txns
         FROM sales s WHERE ${TODAY}`,
      );
      const [refunds] = await d.select<{ refunded: number }[]>(
        `SELECT COALESCE(SUM(total_refunded),0) AS refunded FROM sale_returns
         WHERE date(timestamp) = date('now', 'localtime')`,
      );
      const [items] = await d.select<{ sold: number }[]>(
        `SELECT COALESCE(SUM(si.quantity),0) AS sold FROM sale_items si
         JOIN sales s ON s.id = si.sale_id WHERE ${TODAY}`,
      );
      const pays = await d.select<{ method: string; total: number }[]>(
        `SELECT sp.method AS method, SUM(sp.amount) AS total
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
         WHERE ${TODAY} GROUP BY sp.method`,
      );
      const payMap = Object.fromEntries(pays.map((p) => [p.method, Number(p.total)]));
      // The till float is saved the moment it's typed in Reports; fall back
      // to a completed cash-up's opening float for older days.
      let openingFloat: number | null = null;
      const [f] = await d.select<{ amount: number }[]>(
        `SELECT amount FROM till_floats WHERE day = date('now', 'localtime')`,
      );
      if (f) {
        openingFloat = Number(f.amount);
      } else {
        const [floatRow] = await d.select<{ opening_float: number }[]>(
          `SELECT opening_float FROM cash_ups WHERE day = date('now', 'localtime')
           ORDER BY id DESC LIMIT 1`,
        );
        openingFloat = floatRow ? Number(floatRow.opening_float) : null;
      }
      const [cashExp] = await d.select<{ total: number }[]>(
        `SELECT COALESCE(SUM(amount),0) AS total FROM expenses
         WHERE payment_method = 'Cash' AND date(timestamp) = date('now', 'localtime')`,
      );
      const [stock] = await d.select<{
        out_of_stock: number;
        low_stock: number;
        expiring_soon: number;
        expired: number;
      }[]>(
        `SELECT
           COALESCE(SUM(stock_qty <= 0), 0) AS out_of_stock,
           COALESCE(SUM(stock_qty > 0 AND stock_qty <= reorder_level), 0) AS low_stock,
           COALESCE(SUM(expiry_date IS NOT NULL AND expiry_date != ''
                        AND date(expiry_date) > date('now', 'localtime')
                        AND date(expiry_date) <= date('now', 'localtime', '+30 days')), 0) AS expiring_soon,
           COALESCE(SUM(expiry_date IS NOT NULL AND expiry_date != ''
                        AND date(expiry_date) <= date('now', 'localtime')), 0) AS expired
         FROM products WHERE active = 1`,
      );
      const [orders] = await d.select<{ open_orders: number }[]>(
        `SELECT COUNT(*) AS open_orders FROM purchases
         WHERE cancelled = 0 AND status != 'Received'`,
      );
      const recent = await d.select<
        { receipt_no: string; timestamp: string; total_amount: number; payment_method: string }[]
      >(
        `SELECT receipt_no, timestamp, total_amount, payment_method FROM sales
         ORDER BY id DESC LIMIT 6`,
      );
      setSnap({
        gross: Number(totals?.gross ?? 0),
        txns: Number(totals?.txns ?? 0),
        refunded: Number(refunds?.refunded ?? 0),
        itemsSold: Number(items?.sold ?? 0),
        cashIn: payMap["Cash"] ?? 0,
        cardIn: payMap["Card"] ?? 0,
        momoIn: payMap["MoMo"] ?? 0,
        creditIn: payMap["Credit"] ?? 0,
        openingFloat,
        cashExpenses: Number(cashExp?.total ?? 0),
        outOfStock: Number(stock?.out_of_stock ?? 0),
        lowStock: Number(stock?.low_stock ?? 0),
        expiringSoon: Number(stock?.expiring_soon ?? 0),
        expired: Number(stock?.expired ?? 0),
        openOrders: Number(orders?.open_orders ?? 0),
        recent: recent.map((r) => ({ ...r, total_amount: Number(r.total_amount) })),
      });
      setErr("");
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
    }
  }, []);

  useEffect(() => {
    void load();
    // A counter screen lives on its own all day — refresh quietly each minute.
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const expectedTill = snap ? (snap.openingFloat ?? 0) + snap.cashIn - snap.refunded - snap.cashExpenses : 0;

  return (
    <div className="h-full overflow-y-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-headline-lg font-headline-lg text-on-surface">
            {greeting}
            {operator ? `, ${operator}` : ""}
          </h2>
          <p className="text-body-md font-body-md text-on-surface-variant">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            {" · "}here's where things stand.
          </p>
        </div>
      </div>

      {err && (
        <p className="mb-4 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
          {err}
        </p>
      )}

      {!snap ? (
        <p className="mt-10 text-center text-body-md text-on-surface-variant">Loading…</p>
      ) : (
        <>
          {/* Money tiles */}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-outline-variant bg-surface p-4">
              <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Net sales today
              </p>
              <p className="font-data-mono text-data-mono text-headline-lg font-black text-primary">
                {fmtMoney(snap.gross - snap.refunded)}
              </p>
              <p className="text-[11px] text-on-surface-variant">
                {snap.txns} transaction{snap.txns === 1 ? "" : "s"} · {snap.itemsSold} item
                {snap.itemsSold === 1 ? "" : "s"}
                {snap.refunded > 0 ? ` · −${fmtMoney(snap.refunded)} returned` : ""}
              </p>
            </div>
            <div className="rounded-xl border border-outline-variant bg-surface p-4">
              <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Cash · Card · MoMo
              </p>
              <div className="space-y-0.5 font-data-mono text-data-mono text-body-md text-on-surface">
                <p>{fmtMoney(snap.cashIn)}</p>
                <p>{fmtMoney(snap.cardIn)}</p>
                <p>{fmtMoney(snap.momoIn)}</p>
              </div>
              {snap.creditIn > 0 && (
                <p className="text-[11px] text-warn">+{fmtMoney(snap.creditIn)} on book</p>
              )}
            </div>
            <div className="rounded-xl border border-outline-variant bg-surface p-4">
              <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Expected in till
              </p>
              <p className="font-data-mono text-data-mono text-headline-lg font-black text-on-surface">
                {fmtMoney(expectedTill)}
              </p>
              <p className="text-[11px] text-on-surface-variant">
                {snap.openingFloat !== null
                  ? `float ${fmtMoney(snap.openingFloat)}`
                  : "no float recorded"}
                {" − refunds − cash expenses"}
              </p>
            </div>
            <button
              onClick={() => setPage("analytics")}
              className="rounded-xl border border-outline-variant bg-surface p-4 text-left transition-colors hover:bg-surface-container-low"
            >
              <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Full reports
              </p>
              <p className="text-body-md font-body-md text-primary">
                Cash-up, profit, top products, credit & supplier balances →
              </p>
            </button>
          </div>

          {/* Attention row */}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <AttentionCard
              onClick={() => setPage("inventory")}
              icon="warning"
              tone={snap.outOfStock > 0 ? "error" : snap.lowStock > 0 ? "warn" : "ok"}
              label="Out of stock"
              value={snap.outOfStock}
              sub={`${snap.lowStock} more running low`}
            />
            <AttentionCard
              onClick={() => setPage("inventory")}
              icon="event_busy"
              tone={snap.expiringSoon > 0 ? "warn" : "ok"}
              label="Expiring ≤ 30 days"
              value={snap.expiringSoon}
              sub={`${snap.expired} already expired`}
            />
            <AttentionCard
              onClick={() => setPage("restock")}
              icon="shopping_cart"
              tone={snap.openOrders > 0 ? "info" : "ok"}
              label="Open purchase orders"
              value={snap.openOrders}
              sub="waiting on suppliers"
            />
            <button
              onClick={() => setPage("expenses")}
              className="rounded-xl border border-outline-variant bg-surface p-4 text-left transition-colors hover:bg-surface-container-low"
            >
              <p className="mb-1 flex items-center gap-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                <span className="material-symbols-outlined text-[16px]">receipt_long</span>
                Expenses
              </p>
              <p className="text-body-md font-body-md text-primary">
                Log petty cash & running costs →
              </p>
            </button>
          </div>

          {/* Recent receipts */}
          <div className="overflow-hidden rounded-xl border border-outline-variant bg-surface">
            <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-4 py-2">
              <span className="text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Latest receipts
              </span>
              <button
                onClick={() => setPage("analytics")}
                className="rounded px-2 py-0.5 text-label-md font-label-md text-primary transition-colors hover:bg-primary/10"
              >
                View all in Reports
              </button>
            </div>
            {snap.recent.length === 0 && (
              <p className="p-6 text-center text-body-sm text-on-surface-variant">
                No sales recorded yet — scan something to get started.
              </p>
            )}
            {snap.recent.map((r) => (
              <div
                key={r.receipt_no}
                className="flex items-center border-b border-outline-variant/40 px-4 py-2 last:border-0"
              >
                <span className="w-44 font-data-mono text-data-mono text-on-surface">
                  {r.receipt_no}
                </span>
                <span className="flex-1 text-body-sm text-on-surface-variant">{r.timestamp}</span>
                <span className="w-20 text-right text-body-sm text-on-surface-variant">
                  {r.payment_method}
                </span>
                <span className="w-28 text-right font-data-mono text-data-mono font-bold text-on-surface">
                  {fmtMoney(r.total_amount)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AttentionCard({
  onClick,
  icon,
  tone,
  label,
  value,
  sub,
}: {
  onClick(): void;
  icon: string;
  tone: "ok" | "warn" | "error" | "info";
  label: string;
  value: number;
  sub: string;
}) {
  const toneCls =
    tone === "error"
      ? "border-error/40"
      : tone === "warn"
        ? "border-warn/50"
        : "border-outline-variant";
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border ${toneCls} bg-surface p-4 text-left transition-colors hover:bg-surface-container-low`}
    >
      <p className="mb-1 flex items-center gap-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {label}
      </p>
      <p
        className={`font-data-mono text-data-mono ${
          value > 0 && tone === "error"
            ? "text-error"
            : value > 0 && tone === "warn"
              ? "text-warn"
              : "text-on-surface"
        }`}
      >
        <span className="text-headline-lg font-black">{value}</span>
      </p>
      <p className="text-[11px] text-on-surface-variant">{sub}</p>
    </button>
  );
}
