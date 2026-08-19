import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  initDb,
  backupDb,
  exportReport,
  voidLastSale,
  saveCashUp as dbSaveCashUp,
  listCashUps,
  loadControlledRegister,
  loadCustomerCredit,
  settleCredit,
} from "../db";
import type {
  CashUp,
  CustomerCredit,
  ControlledSummaryRow,
  ControlledTxn,
} from "../db";
import { useStore } from "../store/useStore";
import type { PaymentLine, PaymentMethod } from "../types";
import { fmtMoney } from "../lib/money";
import { beep } from "../lib/audio";
import { ReceiptModal } from "../components/ReceiptModal";
import { ReturnModal } from "../components/ReturnModal";
import { supplierBalances, expenseSummary, type SupplierBalance } from "../db";

type Range = "today" | "yesterday" | "week7" | "month30" | "month" | "custom";

interface ByRow {
  label: string;
  amt: number;
  n: number;
}

interface Report {
  summary: { n: number; revenue: number; items: number; profit: number };
  returns: { amount: number; n: number };
  byMethod: ByRow[];
  byOperator: ByRow[];
  byCategory: (ByRow & { qty: number; profit: number })[];
  top: { product_name: string; qty: number; amt: number }[];
  recent: {
    id: number;
    receipt_no: string;
    total_amount: number;
    payment_method: string;
    operator: string | null;
    timestamp: string;
  }[];
  slow: { name: string; stock_qty: number; value: number }[];
  adjustments: {
    product_name: string;
    delta: number;
    reason: string;
    operator: string | null;
    timestamp: string;
  }[];
  /** Id of today's last sale — the only sale the Void action may target. */
  voidableId: number | null;
  /** Operator names found on sales in the range (for the filter dropdown). */
  legacyOps: string[];
}

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

async function fetchReport(
  from: string,
  to: string,
  op: string | null,
  method: string | null,
): Promise<Report> {
  const db = await initDb();
  const p: unknown[] = [from, to];
  // Operator filter (position 3): every sales-based query aliases `s`, and
  // returns alias `sr` (a refund is stamped with whoever processed it).
  let opC = "";
  let opRetC = "";
  if (op) {
    opC = " AND s.operator = $3";
    opRetC = " AND sr.operator = $3";
    p.push(op);
  }
  // Payment-type filter (last position): a sale matches when ANY of its
  // split payment lines is that method, or — for legacy sales recorded
  // before split payments — its primary payment_method is.
  let mC = "";
  if (method) {
    const idx = p.length + 1;
    mC = ` AND (EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = $${idx})
             OR (NOT EXISTS (SELECT 1 FROM sale_payments sp2 WHERE sp2.sale_id = s.id) AND s.payment_method = $${idx}))`;
    p.push(method);
  }

  const [summary] = await db.select<{ n: number; revenue: number }[]>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS revenue FROM sales s WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}`,
    p,
  );
  const [vol] = await db.select<{ items: number; profit: number }[]>(
    `SELECT COALESCE(SUM(si.quantity),0) AS items,
            COALESCE(SUM((si.unit_price - COALESCE(p.cost_price,0)) * si.quantity),0) AS profit
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}`,
    p,
  );
  const byMethod = await db.select<{ method: string; amt: number; n: number }[]>(
    `SELECT method, SUM(amount) AS amt, COUNT(*) AS n FROM (
       SELECT sp.method AS method, sp.amount AS amount
       FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
       WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}
       UNION ALL
       SELECT s.payment_method, s.total_amount FROM sales s
       WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}
         AND NOT EXISTS (SELECT 1 FROM sale_payments sp2 WHERE sp2.sale_id = s.id)
     ) GROUP BY method ORDER BY amt DESC`,
    p,
  );
  const byOperator = await db.select<{ operator: string | null; amt: number; n: number }[]>(
    `SELECT operator, COUNT(*) AS n, SUM(total_amount) AS amt
     FROM sales s WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}
     GROUP BY operator ORDER BY amt DESC`,
    p,
  );
  const byCategory = await db.select<
    { category: string | null; qty: number; amt: number; profit: number; n: number }[]
  >(
    `SELECT p.category, SUM(si.quantity) AS qty,
            SUM(si.unit_price * si.quantity) AS amt,
            SUM((si.unit_price - COALESCE(p.cost_price,0)) * si.quantity) AS profit,
            COUNT(DISTINCT s.id) AS n
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}
     GROUP BY p.category ORDER BY amt DESC`,
    p,
  );
  const top = await db.select<{ product_name: string; qty: number; amt: number }[]>(
    `SELECT si.product_name, SUM(si.quantity) AS qty, SUM(si.quantity * si.unit_price) AS amt
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC}
     GROUP BY si.product_name ORDER BY qty DESC LIMIT 8`,
    p,
  );
  const recent = await db.select<Report["recent"]>(
    `SELECT id, receipt_no, total_amount, payment_method, operator, timestamp FROM sales s WHERE date(s.timestamp) BETWEEN $1 AND $2${opC}${mC} ORDER BY id DESC LIMIT 10`,
    p,
  );
  const [returns] = await db.select<{ amount: number; n: number }[]>(
    `SELECT COALESCE(SUM(sr.total_refunded),0) AS amount, COUNT(*) AS n
     FROM sale_returns sr JOIN sales s ON s.id = sr.sale_id
     WHERE date(sr.timestamp) BETWEEN $1 AND $2${opRetC}${mC}`,
    p,
  );
  const [latestToday] = await db.select<{ id: number }[]>(
    "SELECT id FROM sales WHERE date(timestamp) = date('now','localtime') ORDER BY id DESC LIMIT 1",
  );
  const adjustments = await db.select<Report["adjustments"]>(
    "SELECT product_name, delta, reason, operator, timestamp FROM stock_adjustments ORDER BY id DESC LIMIT 10",
  );
  const legacyOps = await db.select<{ operator: string }[]>(
    `SELECT DISTINCT operator FROM sales WHERE date(timestamp) BETWEEN $1 AND $2 AND operator IS NOT NULL AND operator != '' ORDER BY operator`,
    [from, to],
  );
  const slow = await db.select<Report["slow"]>(
    `SELECT p.name, p.stock_qty, (p.stock_qty * COALESCE(p.cost_price,0)) AS value
     FROM products p
     WHERE p.stock_qty > 0
       AND NOT EXISTS (
         SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = p.id AND s.timestamp >= datetime('now', '-90 days')
       )
     ORDER BY value DESC`,
  );
  return {
    summary: {
      n: Number(summary?.n ?? 0),
      revenue: Number(summary?.revenue ?? 0),
      items: Number(vol?.items ?? 0),
      profit: Number(vol?.profit ?? 0),
    },
    returns: {
      amount: Number(returns?.amount ?? 0),
      n: Number(returns?.n ?? 0),
    },
    byMethod: byMethod.map((m) => ({ label: m.method, amt: Number(m.amt), n: Number(m.n) })),
    byOperator: byOperator.map((o) => ({
      label: o.operator?.trim() || "—",
      amt: Number(o.amt),
      n: Number(o.n),
    })),
    byCategory: byCategory.map((c) => ({
      label: c.category?.trim() || "—",
      qty: Number(c.qty),
      amt: Number(c.amt),
      profit: Number(c.profit),
      n: Number(c.n),
    })),
    top: top.map((t) => ({ ...t, qty: Number(t.qty), amt: Number(t.amt) })),
    recent: recent.map((r) => ({ ...r, total_amount: Number(r.total_amount) })),
    slow: slow.map((s) => ({ ...s, stock_qty: Number(s.stock_qty), value: Number(s.value) })),
    adjustments: adjustments.map((a) => ({ ...a, delta: Number(a.delta) })),
    voidableId: latestToday ? Number(latestToday.id) : null,
    legacyOps: legacyOps.map((o) => o.operator).filter(Boolean),
  };
}

export function AnalyticsPage() {
  const products = useStore((s) => s.products);
  const operator = useStore((s) => s.operator);
  const operators = useStore((s) => s.operators);
  const refreshProducts = useStore((s) => s.refreshProducts);
  const [range, setRange] = useState<Range>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [opFilter, setOpFilter] = useState("All");
  const [methodFilter, setMethodFilter] = useState("All");
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [returnSale, setReturnSale] = useState<{
    id: number;
    receipt_no: string;
    timestamp: string;
  } | null>(null);
  const [voidArmed, setVoidArmed] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierBalance[]>([]);
  const [expenses, setExpenses] = useState<{ total: number; byCategory: { category: string; total: number }[] } | null>(null);

  // ---- Daily cash-up ----
  const [cashDay, setCashDay] = useState(fmt(new Date()));
  const [cashFloat, setCashFloat] = useState("");
  const [cashCounted, setCashCounted] = useState("");
  const [cashUps, setCashUps] = useState<CashUp[]>([]);
  const [cashData, setCashData] = useState({ sales: 0, refunds: 0, expenses: 0 });
  const [cashErr, setCashErr] = useState("");
  const [cashBusy, setCashBusy] = useState(false);
  const [cashSaved, setCashSaved] = useState(false);

  const cashOp = opFilter === "All" ? null : opFilter;
  useEffect(() => {
    void (async () => {
      try {
        const db = await initDb();
        const opCond = cashOp ? " AND s.operator = $2" : "";
        const p = cashOp ? [cashDay, cashOp] : [cashDay];
        const [sales] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(SUM(sp.amount),0) AS v FROM sale_payments sp
           JOIN sales s ON s.id = sp.sale_id
           WHERE sp.method = 'Cash' AND date(s.timestamp) = $1${opCond}`,
          p,
        );
        const [refunds] = await db.select<{ v: number }[]>(
          `SELECT COALESCE(SUM(sr.total_refunded),0) AS v FROM sale_returns sr
           JOIN sales s ON s.id = sr.sale_id
           WHERE s.payment_method = 'Cash' AND date(sr.timestamp) = $1${opCond}`,
          p,
        );
        // Cash expenses for the day (paid from till). May fail if migration hasn't run.
        let dayExpenses = 0;
        try {
          const [expRow] = await db.select<{ v: number }[]>(
            "SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE date(timestamp) = $1",
            [cashDay],
          );
          dayExpenses = Number(expRow?.v ?? 0);
        } catch { /* expenses table may not exist yet */ }
        setCashData({
          sales: Number(sales?.v ?? 0),
          refunds: Number(refunds?.v ?? 0),
          expenses: dayExpenses,
        });
        const ups = await listCashUps(cashDay);
        setCashUps(ups);
        if (ups.length > 0 && cashFloat === "") {
          setCashFloat(String(ups[0].opening_float));
        }
        setCashErr("");
      } catch (e) {
        setCashErr(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashDay, cashOp]);

  const cashExpected = (Number(cashFloat) || 0) + cashData.sales - cashData.refunds - cashData.expenses;
  const cashVariance = Math.round(((Number(cashCounted) || 0) - cashExpected) * 100) / 100;

  const doCashUp = async () => {
    const counted = Number(cashCounted);
    if (!cashCounted.trim() || Number.isNaN(counted)) {
      setCashErr("Enter the counted amount from the till.");
      beep(false);
      return;
    }
    setCashBusy(true);
    setCashErr("");
    try {
      await dbSaveCashUp({
        day: cashDay,
        opening_float: Number(cashFloat) || 0,
        counted,
        variance: cashVariance,
        operator,
      });
      setCashUps(await listCashUps(cashDay));
      setCashSaved(true);
      setTimeout(() => setCashSaved(false), 1500);
      beep(true);
    } catch (e) {
      setCashErr(String(e));
      beep(false);
    } finally {
      setCashBusy(false);
    }
  };
  // ---- Controlled-drug register + customer credit ledger ----
  const [controlled, setControlled] = useState<{
    summary: ControlledSummaryRow[];
    txns: ControlledTxn[];
  } | null>(null);
  const [credit, setCredit] = useState<CustomerCredit[]>([]);
  const [settling, setSettling] = useState<string | null>(null);
  const [settleAmt, setSettleAmt] = useState("");
  const [settleMethod, setSettleMethod] = useState("Cash");
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleErr, setSettleErr] = useState("");

  const SETTLE_METHODS = ["Cash", "Mobile Money", "Bank Transfer", "Cheque"];
  const kindCls = (k: ControlledTxn["kind"]) =>
    k === "Dispensed"
      ? "bg-error/10 text-error"
      : k === "Received"
        ? "bg-primary/10 text-primary"
        : k === "Returned"
          ? "bg-surface-variant text-on-surface-variant"
          : "bg-warn-muted text-warn";
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const doSettle = async (c: CustomerCredit) => {
    const a = Number(settleAmt);
    if (!Number.isFinite(a) || a <= 0) {
      setSettleErr("Enter a positive amount.");
      beep(false);
      return;
    }
    setSettleBusy(true);
    setSettleErr("");
    try {
      await settleCredit(c.name, a, settleMethod, operator || null);
      beep(true);
      setCredit(await loadCustomerCredit());
      setSettling(null);
    } catch (e) {
      setSettleErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setSettleBusy(false);
    }
  };

  const [reprint, setReprint] = useState<{
    result: { receipt_no: string; sale_id: number; total: number; change: number };
    lines: { productId: number; name: string; unit: string | null; unitPrice: number; qty: number }[];
    subtotal: number;
    tax: number;
    method: string;
    payments?: PaymentLine[];
  } | null>(null);

  const { from, to } = useMemo(
    () => rangeDates(range, customFrom, customTo),
    [range, customFrom, customTo],
  );


  const rangeLabel = useMemo(() => {
    switch (range) {
      case "today":
        return "today";
      case "yesterday":
        return "yesterday";
      case "week7":
        return "last7";
      case "month30":
        return "last30";
      case "month":
        return "this-month";
      case "custom":
        return `${from}_to_${to}`;
    }
  }, [range, from, to]);

  // Operator dropdown = shift roster (with windows) + any operator found on
  // sales in the range, so you can filter by someone who has no sales yet.
  const opOptions = useMemo(() => {
    const roster = new Map(operators.map((o) => [o.name, o]));
    const names = new Set<string>([...roster.keys(), ...(report?.legacyOps ?? [])]);
    return Array.from(names)
      .sort()
      .map((n) => {
        const op = roster.get(n);
        return op?.shift_start && op.shift_end
          ? { name: n, label: `${n} (${op.shift_start}–${op.shift_end})` }
          : { name: n, label: n };
      });
  }, [operators, report]);  const load = useCallback(async () => {
    try {
      const [rep, ctrl] = await Promise.all([
        fetchReport(
          from,
          to,
          opFilter === "All" ? null : opFilter,
          methodFilter === "All" ? null : methodFilter,
        ),
        loadControlledRegister(from, to).catch((e) => {
          setErr(String(e));
          return null;
        }),
      ]);
      setReport(rep);
      setErr("");
      if (ctrl) setControlled(ctrl);
    } catch (e) {
      setErr(String(e));
    }
    // Customer credit loads on its own fast path — it must never be delayed
    // (or hidden) by the slower report/register queries, so the card below
    // the KPIs always populates immediately.
    loadCustomerCredit()
      .then((cr) => setCredit(cr))
      .catch((e) => setErr(String(e)));
    supplierBalances()
      .then((sb) => setSuppliers(sb))
      .catch(() => setSuppliers([]));
    expenseSummary(from, to)
      .then((es) => setExpenses(es))
      .catch(() => setExpenses({ total: 0, byCategory: [] }));
  }, [from, to, opFilter, methodFilter]);



  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();
  const todayStr = fmt(now);
  const in60 = new Date(now);
  in60.setDate(in60.getDate() + 60);
  const in60Str = fmt(in60);

  const lowStock = products.filter(
    (p) => p.stock_qty > 0 && p.stock_qty <= p.reorder_level,
  );
  const expiring = products.filter(
    (p) => p.expiry_date && p.expiry_date > todayStr && p.expiry_date <= in60Str,
  );
  const expired = products.filter(
    (p) => p.expiry_date && p.expiry_date < todayStr,
  );

  const doBackup = async () => {
    try {
      setBackupPath(await backupDb());
      beep(true);
    } catch (e) {
      setErr(String(e));
      beep(false);
    }
  };

  /** Two-step void (mirrors the operator delete pattern): tap once to arm, again within 2.5s to execute. */
  const armVoid = (receiptNo: string) => {
    if (voidArmed !== receiptNo) {
      setVoidArmed(receiptNo);
      window.setTimeout(() => setVoidArmed((v) => (v === receiptNo ? null : v)), 2500);
      return;
    }
    setVoidArmed(null);
    void (async () => {
      try {
        const r = await voidLastSale(operator);
        await refreshProducts();
        await load();
        setErr("");
        setNotice(`${r.receipt_no} voided — stock returned.`);
        setTimeout(() => setNotice(""), 5000);
        beep(true);
      } catch (e) {
        setErr(String(e).replace(/^Error: /, ""));
        beep(false);
      }
    })();
  };

  const doExport = async () => {
    if (!report) return;
    const rows: string[][] = [];
    rows.push([`Pulse Reports — ${rangeLabel}`]);
    rows.push([`Operator: ${opFilter}`]);
    rows.push([`Payment: ${methodFilter}`]);
    rows.push([]);
    rows.push(["Summary", "Transactions", "Items Sold", "Gross Profit (GH₵)"]);
    rows.push([
      report.summary.revenue.toFixed(2),
      String(report.summary.n),
      String(report.summary.items),
      report.summary.profit.toFixed(2),
    ]);
    rows.push([]);
    rows.push(["Returns", "Count", "Refunded (GH₵)", "Net Revenue (GH₵)"]);
    rows.push([
      "",
      String(report.returns.n),
      report.returns.amount.toFixed(2),
      Math.max(0, report.summary.revenue - report.returns.amount).toFixed(2),
    ]);
    rows.push([]);
    rows.push(["By Payment", "Revenue (GH₵)", "Count"]);
    report.byMethod.forEach((m) => rows.push([m.label, m.amt.toFixed(2), String(m.n)]));
    rows.push([]);
    rows.push(["By Operator", "Revenue (GH₵)", "Count"]);
    report.byOperator.forEach((o) => rows.push([o.label, o.amt.toFixed(2), String(o.n)]));
    rows.push([]);
    rows.push(["By Category", "Units", "Revenue (GH₵)", "Profit (GH₵)", "Sales"]);
    report.byCategory.forEach((c) =>
      rows.push([c.label, String(c.qty), c.amt.toFixed(2), c.profit.toFixed(2), String(c.n)]),
    );
    rows.push([]);
    rows.push(["Top Products", "Units", "Revenue (GH₵)"]);
    report.top.forEach((t) => rows.push([t.product_name, String(t.qty), t.amt.toFixed(2)]));
    rows.push([]);
    rows.push(["Recent Sales", "Method", "Operator", "Total (GH₵)", "Time"]);
    report.recent.forEach((r) =>
      rows.push([r.receipt_no, r.payment_method, r.operator ?? "", r.total_amount.toFixed(2), r.timestamp]),
    );
    rows.push([]);
    rows.push(["Slow Movers (no sale in 90 days)", "Stock Qty", "Stock Value (GH₵)"]);
    report.slow.forEach((s) => rows.push([s.name, String(s.stock_qty), s.value.toFixed(2)]));
    rows.push([]);
    rows.push(["Controlled Drugs — Register", "Stock", "Received", "Dispensed", "Returned", "Adjusted"]);
    (controlled?.summary ?? []).forEach((c) =>
      rows.push([
        c.name,
        String(c.stock_qty),
        String(c.received),
        String(c.dispensed),
        String(c.returned),
        String(c.adjusted),
      ]),
    );
    rows.push([]);
    rows.push(["Customer Credit (book)", "Owed (GH₵)", "Settled (GH₵)", "Balance (GH₵)"]);
    credit.forEach((c) =>
      rows.push([
        c.name,
        c.owed.toFixed(2),
        c.settled.toFixed(2),
        (c.owed - c.settled).toFixed(2),
      ]),
    );
    try {
      const opSuffix =
        opFilter !== "All"
          ? `-${opFilter.toLowerCase().replace(/[^a-z0-9]/g, "")}`
          : "";
      const mSuffix = methodFilter !== "All" ? `-${methodFilter.toLowerCase()}` : "";
      const fname = `sales-${rangeLabel}${opSuffix}${mSuffix}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-");
      const picked = await save({
        defaultPath: `${fname}.csv`,
        filters: [{ name: "CSV file", extensions: ["csv"] }],
      });
      if (!picked) return; // dialog cancelled — nothing written
      const p = await exportReport(picked, rows);
      setExportPath(p);
      beep(true);
    } catch (e) {
      setErr(String(e));
      beep(false);
    }
  };

  const doReprint = async (receiptNo: string) => {
    try {
      const db = await initDb();
      const [sale] = await db.select<
        { id: number; receipt_no: string; total_amount: number; payment_method: string }[]
      >("SELECT id, receipt_no, total_amount, payment_method FROM sales WHERE receipt_no = $1", [
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
      setReprint({
        result: {
          receipt_no: sale.receipt_no,
          sale_id: sale.id,
          total: Number(sale.total_amount),
          change: 0,
        },
        lines: items.map((i) => ({
          productId: 0,
          name: i.product_name,
          unit: i.unit,
          unitPrice: Number(i.unit_price),
          qty: Number(i.quantity),
        })),
        subtotal: Number(sale.total_amount),
        tax: 0,
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
      setErr(String(e));
      beep(false);
    }
  };

  const RANGES: { id: Range; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "week7", label: "Last 7 days" },
    { id: "month30", label: "Last 30 days" },
    { id: "month", label: "This Month" },
    { id: "custom", label: "Custom…" },
  ];

  const PAY_METHODS = ["Cash", "Card", "MoMo", "Credit"];

  const gross = report ? report.summary.revenue : 0;
  const returns = report ? report.returns.amount : 0;
  const kpis = [
    { label: "Gross Sales", value: report ? fmtMoney(gross) : "—" },
    { label: "Returns", value: report ? `−${fmtMoney(returns)}` : "—", negative: true },
    { label: "Net Revenue", value: report ? fmtMoney(Math.max(0, gross - returns)) : "—" },
    { label: "Transactions", value: report ? String(report.summary.n) : "—" },
    { label: "Items Sold", value: report ? String(report.summary.items) : "—" },
    { label: "Gross Profit", value: report ? fmtMoney(report.summary.profit) : "—" },
    { label: "Expenses", value: expenses ? fmtMoney(expenses.total) : "—", negative: expenses && expenses.total > 0 },
    { label: "Net Profit", value: report && expenses ? fmtMoney(report.summary.profit - expenses.total) : "—" },
  ];

  const td = "px-3 py-1 text-body-sm text-on-surface";

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-headline-lg font-headline-lg font-bold text-on-surface">
            Reports
          </h2>
          <p className="text-body-md font-body-md text-on-surface-variant">
            Sales, operators, categories, and stock — all local.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
            title="Report period"
            className="h-8 rounded border border-outline-variant bg-surface px-2 text-label-md font-label-md text-on-surface focus:border-primary focus:outline-none"
          >
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-8 rounded border border-outline-variant bg-surface px-2 font-data-mono text-data-mono text-on-surface"
              />
              <span className="text-on-surface-variant">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-8 rounded border border-outline-variant bg-surface px-2 font-data-mono text-data-mono text-on-surface"
              />
            </>
          )}
          <select
            value={opFilter}
            onChange={(e) => setOpFilter(e.target.value)}
            title="Filter every report section by operator"
            className="h-8 rounded border border-outline-variant bg-surface px-2 text-label-md font-label-md text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="All">Operator: All</option>
            {opOptions.map((o) => (
              <option key={o.name} value={o.name}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            title="Filter every report section by payment type"
            className="h-8 rounded border border-outline-variant bg-surface px-2 text-label-md font-label-md text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="All">Payment: All</option>
            {PAY_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            onClick={() => void load()}
            className="rounded border border-outline-variant bg-surface px-3 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-container-low"
          >
            Refresh
          </button>
          <button
            onClick={() => void doExport()}
            className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-label-md font-label-md text-on-surface transition-colors hover:bg-surface-container-low"
            title="Write every section to a CSV (choose where to save)"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            Export CSV
          </button>
          <button
            onClick={() => void doBackup()}
            className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-label-md font-label-md text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
            title="WAL-safe backup to backups/"
          >
            <span className="material-symbols-outlined text-[16px]">save</span>
            Backup
          </button>
        </div>
      </div>

      {exportPath && (
        <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
          Exported to: {exportPath}
        </p>
      )}
      {backupPath && (
        <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
          Backup saved to: {backupPath}
        </p>
      )}
      {err && (
        <p className="mb-3 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
          {err}
        </p>
      )}
      {notice && (
        <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
          {notice}
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className={`rounded border border-outline-variant bg-surface p-3 ${k.negative ? "border-error/30 bg-error/5" : ""}`}>
            <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              {k.label}
            </span>
            <p className={`mt-1 text-headline-lg font-headline-lg font-bold ${k.negative ? "text-error" : "text-on-surface"}`}>
              {k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-4 overflow-clip rounded border border-warn/60 bg-surface">
        <h3 className="flex items-center justify-between border-b border-outline-variant bg-warn-subtle px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
          <span>Customer Credit (book) — what customers owe</span>
          {credit.length > 0 && (
            <span className="rounded-full bg-[#b45309] dark:bg-[#d97706] px-2 py-0.5 text-[10px] font-bold text-white">
              {credit.length} customer{credit.length === 1 ? "" : "s"} ·{" "}
              {fmtMoney(credit.reduce((s, c) => s + c.owed - c.settled, 0))}
            </span>
          )}
        </h3>
        {credit.length > 0 ? (
          <div className="divide-y divide-outline-variant/50">
            {credit.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-body-sm font-semibold text-on-surface">{c.name}</p>
                  <p className="font-data-mono text-[11px] text-on-surface-variant">
                    owes {fmtMoney(c.owed - c.settled)}
                    {c.settled > 0 ? ` · settled ${fmtMoney(c.settled)}` : ""}
                  </p>
                </div>
                {settling === c.name ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={settleAmt}
                      onChange={(e) => setSettleAmt(e.target.value)}
                      placeholder="0.00"
                      className="h-7 w-20 rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono focus:border-primary focus:outline-none"
                    />
                    <select
                      value={settleMethod}
                      onChange={(e) => setSettleMethod(e.target.value)}
                      className="h-7 rounded border border-outline-variant bg-surface-container-lowest px-1 text-body-sm focus:border-primary focus:outline-none"
                    >
                      {SETTLE_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void doSettle(c)}
                      disabled={settleBusy}
                      className="rounded bg-primary px-2 py-1 text-label-md font-label-md text-on-primary hover:bg-on-primary-fixed-variant disabled:opacity-50"
                    >
                      {settleBusy ? "…" : "Record"}
                    </button>
                    <button
                      onClick={() => setSettling(null)}
                      className="rounded border border-outline px-2 py-1 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setSettling(c.name);
                      setSettleAmt(String(round2(c.owed - c.settled)));
                      setSettleErr("");
                    }}
                    className="flex items-center gap-1 rounded border border-primary/40 bg-primary/5 px-2 py-1 text-label-md font-label-md text-primary hover:bg-primary/10"
                  >
                    <span className="material-symbols-outlined text-[14px]">payments</span>
                    Settle
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-3 py-2 text-body-sm text-on-surface-variant">
            No outstanding balances — everyone has settled.
          </p>
        )}
        {settleErr && <p className="px-3 py-2 text-body-sm text-error">{settleErr}</p>}
      </div>

      {suppliers.length > 0 && (
        <div className="mb-4 overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            Supplier Balances
          </h3>
          <div className="divide-y divide-outline-variant/50">
            {suppliers.map((s) => (
              <div key={s.supplier_name} className="flex items-center justify-between px-3 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-body-sm font-semibold text-on-surface">{s.supplier_name}</p>
                  <p className="font-data-mono text-[11px] text-on-surface-variant">
                    {s.invoice_count} invoice{s.invoice_count === 1 ? "" : "s"} · oldest {s.oldest_date ?? "—"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-data-mono text-data-mono text-on-surface-variant">
                    purchased {fmtMoney(s.total_purchased)} · paid {fmtMoney(s.total_paid)}
                  </p>
                  <p className={`font-data-mono text-data-mono font-bold ${s.balance > 0 ? "text-error" : "text-success"}`}>
                    {s.balance > 0 ? `owes ${fmtMoney(s.balance)}` : "settled"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            By Payment
          </h3>
          {report && report.byMethod.length === 0 && (
            <p className="px-3 py-4 text-body-sm text-on-surface-variant">No sales in this range.</p>
          )}
          {report?.byMethod.map((m) => (
            <div key={m.label} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
              <span className={td}>{m.label}</span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(m.amt)} <span className="text-on-surface-variant">({m.n})</span>
              </span>
            </div>
          ))}
        </div>

        <div className="overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            By Operator
          </h3>
          {report && report.byOperator.length === 0 && (
            <p className="px-3 py-4 text-body-sm text-on-surface-variant">
              No sales in this range. Set the operator in Settings.
            </p>
          )}
          {report?.byOperator.map((o) => (
            <div key={o.label} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
              <span className={td}>{o.label}</span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(o.amt)} <span className="text-on-surface-variant">({o.n})</span>
              </span>
            </div>
          ))}
        </div>

        <div className="overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            By Category
          </h3>
          {report && report.byCategory.length === 0 && (
            <p className="px-3 py-4 text-body-sm text-on-surface-variant">No sales in this range.</p>
          )}
          {report?.byCategory.map((c) => (
            <div key={c.label} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
              <span className={td}>
                {c.label}
                <span className="ml-2 text-[11px] text-on-surface-variant">
                  {c.qty} units · {fmtMoney(c.profit)} profit
                </span>
              </span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(c.amt)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            Top Products
          </h3>
          {report && report.top.length === 0 && (
            <p className="px-3 py-4 text-body-sm text-on-surface-variant">No sales in this range.</p>
          )}
          {report?.top.map((t) => (
            <div key={t.product_name} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
              <span className={td}>
                {t.product_name}
                <span className="ml-2 text-[11px] text-on-surface-variant">{t.qty} units</span>
              </span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(t.amt)}
              </span>
            </div>
          ))}
        </div>

        <div className="overflow-clip rounded border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            Recent Sales{" "}
            <span className="font-normal normal-case text-on-surface-variant">(click to reprint)</span>
          </h3>
          {report && report.recent.length === 0 && (
            <p className="px-3 py-4 text-body-sm text-on-surface-variant">No sales in this range.</p>
          )}
          {report?.recent.map((r) => (
            <div
              key={r.receipt_no}
              onClick={() => void doReprint(r.receipt_no)}
              className="flex w-full cursor-pointer items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 text-left transition-colors last:border-0 hover:bg-surface-container-low"
            >
              <span className={td}>
                <span className="font-data-mono text-data-mono font-semibold">{r.receipt_no}</span>
                <span className="ml-2 text-[11px] text-on-surface-variant">
                  {r.payment_method} · {r.operator || "—"} · {r.timestamp}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {report.voidableId === r.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      armVoid(r.receipt_no);
                    }}
                    title="Delete today's last sale entirely — stock returns (two taps)"
                    className={`rounded px-2 py-0.5 text-[11px] font-bold transition-colors ${
                      voidArmed === r.receipt_no
                        ? "bg-error text-on-error"
                        : "text-error hover:bg-error/10"
                    }`}
                  >
                    {voidArmed === r.receipt_no ? "Void?" : "Void"}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setReturnSale({ id: r.id, receipt_no: r.receipt_no, timestamp: r.timestamp });
                  }}
                  title="Refund part or all of this sale"
                  className="rounded px-2 py-0.5 text-[11px] font-bold text-primary transition-colors hover:bg-primary/10"
                >
                  Return
                </button>
                <span className="font-data-mono text-data-mono font-bold text-on-surface">
                  {fmtMoney(r.total_amount)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-4 overflow-clip rounded border border-outline-variant bg-surface">
        <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
          Recent Stock Adjustments
        </h3>
        {report && report.adjustments.length === 0 && (
          <p className="px-3 py-4 text-body-sm text-on-surface-variant">
            None yet. Adjust stock from Inventory (damaged, expired, counting error…).
          </p>
        )}
        {report?.adjustments.map((a, i) => (
          <div key={i} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
            <span className={td}>
              {a.product_name}
              <span className="ml-2 text-[11px] text-on-surface-variant">
                {a.reason}
                {a.operator ? ` · ${a.operator}` : ""} · {a.timestamp}
              </span>
            </span>
            <span
              className={`font-data-mono text-data-mono font-bold ${
                a.delta > 0 ? "text-primary" : "text-error"
              }`}
            >
              {a.delta > 0 ? `+${a.delta}` : a.delta}
            </span>
          </div>
        ))}
      </div>

      <div className="mb-4 overflow-clip rounded border border-outline-variant bg-surface">
        <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
          Daily Cash-up
        </h3>
        <div className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-body-sm font-body-sm text-on-surface-variant">
              Day
              <input
                type="date"
                value={cashDay}
                onChange={(e) => {
                  setCashDay(e.target.value);
                  setCashFloat("");
                  setCashCounted("");
                }}
                className="h-8 rounded border border-outline-variant bg-surface-container-lowest px-2 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
              />
            </label>
            <span className="text-body-sm text-on-surface-variant">
              Cash in the till = opening float + cash sales − cash refunds
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Opening float (GH₵)
              </span>
              <input
                value={cashFloat}
                onChange={(e) => setCashFloat(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
              />
            </label>
            <div className="rounded border border-outline-variant/50 bg-surface-container-low p-2">
              <span className="block text-label-md font-label-md text-on-surface-variant">Cash sales</span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(cashData.sales)}
              </span>
            </div>
            <div className="rounded border border-outline-variant/50 bg-surface-container-low p-2">
              <span className="block text-label-md font-label-md text-on-surface-variant">Cash refunds</span>
              <span className="font-data-mono text-data-mono font-bold text-error">
                −{fmtMoney(cashData.refunds)}
              </span>
            </div>
            {cashData.expenses > 0 && (
              <div className="rounded border border-outline-variant/50 bg-surface-container-low p-2">
                <span className="block text-label-md font-label-md text-on-surface-variant">Expenses paid</span>
                <span className="font-data-mono text-data-mono font-bold text-error">
                  −{fmtMoney(cashData.expenses)}
                </span>
              </div>
            )}
            <div className="rounded border border-primary/20 bg-primary/5 p-2">
              <span className="block text-label-md font-label-md text-primary">Expected in till</span>
              <span className="font-data-mono text-data-mono font-bold text-primary">
                {fmtMoney(cashExpected)}
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-label-md font-label-md text-on-surface">
                Counted (GH₵)
              </span>
              <input
                value={cashCounted}
                onChange={(e) => setCashCounted(e.target.value)}
                inputMode="decimal"
                placeholder="What's actually in the till"
                className="h-9 w-52 rounded border border-outline-variant bg-surface-container-lowest px-3 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
              />
            </label>
            <div className="pb-1">
              <span className="block text-label-md font-label-md text-on-surface-variant">Variance</span>
              <span
                className={`font-data-mono text-data-mono text-headline-md font-bold ${
                  cashVariance >= 0 ? "text-primary" : "text-error"
                }`}
              >
                {cashCounted.trim() ? `${cashVariance >= 0 ? "+" : ""}${fmtMoney(cashVariance)}` : "—"}
              </span>
            </div>
            <button
              onClick={() => void doCashUp()}
              disabled={cashBusy}
              className="h-9 rounded bg-primary px-6 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              {cashSaved ? "Saved ✓" : cashBusy ? "Saving…" : "Save cash-up"}
            </button>
          </div>
          {cashErr && <p className="mt-2 text-body-sm font-body-sm text-error">{cashErr}</p>}
          {cashUps.length > 0 && (
            <div className="mt-3 border-t border-outline-variant/50 pt-2">
              <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                Saved cash-ups for this day
              </p>
              {cashUps.slice(0, 5).map((u) => (
                <div key={u.id} className="flex items-center justify-between py-0.5 text-body-sm text-on-surface">
                  <span>
                    float {fmtMoney(u.opening_float)} · counted {fmtMoney(u.counted)}
                    {u.operator ? ` · ${u.operator}` : ""} · {u.timestamp}
                  </span>
                  <span
                    className={`font-data-mono text-data-mono font-bold ${
                      u.variance >= 0 ? "text-primary" : "text-error"
                    }`}
                  >
                    {u.variance >= 0 ? "+" : ""}
                    {fmtMoney(u.variance)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {[
          { title: "Low Stock", rows: lowStock, hint: (p: (typeof products)[number]) => `${p.stock_qty} left (reorder at ${p.reorder_level})` },
          { title: "Expiring ≤ 60 days", rows: expiring, hint: (p: (typeof products)[number]) => `Expires ${p.expiry_date}` },
          { title: "Expired", rows: expired, hint: (p: (typeof products)[number]) => `Expired ${p.expiry_date}` },
        ].map((s) => (
          <div key={s.title} className="overflow-clip rounded border border-outline-variant bg-surface">
            <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
              {s.title}
            </h3>
            {s.rows.length === 0 && (
              <p className="px-3 py-4 text-body-sm text-on-surface-variant">None — good.</p>
            )}
            {s.rows.slice(0, 8).map((p) => (
              <div key={p.id} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
                <span className={td}>{p.name}</span>
                <span className="text-[11px] text-on-surface-variant">{s.hint(p)}</span>
              </div>
            ))}
            {s.rows.length > 8 && (
              <p className="px-3 py-1.5 text-[11px] text-on-surface-variant">
                +{s.rows.length - 8} more (see Inventory)
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="overflow-clip rounded border border-outline-variant bg-surface">
        <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
          Slow Movers — no sale in 90 days (cash tied up on the shelf)
        </h3>
        {!report || report.slow.length === 0 ? (
          <p className="px-3 py-4 text-body-sm text-on-surface-variant">
            {report ? "None — everything is moving." : "Loading…"}
          </p>
        ) : (
          <div className="divide-y divide-outline-variant/50">
            {report.slow.slice(0, 12).map((s) => (
              <div key={s.name} className="flex items-center justify-between px-3 py-1.5">
                <span className={td}>{s.name}</span>
                <span className="text-[11px] text-on-surface-variant">
                  {s.stock_qty} in stock · {fmtMoney(s.value)} cost value
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-clip rounded border border-outline-variant bg-surface">
        <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
          Controlled Drug Register — {rangeLabel}
        </h3>
        {!controlled || controlled.summary.length === 0 ? (
          <p className="px-3 py-4 text-body-sm text-on-surface-variant">
            {controlled
              ? "No controlled products on file — mark an item 'Controlled drug' on import or in the catalog."
              : "Loading…"}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-outline-variant/50 bg-surface-container-lowest px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
              <span className="flex-1">Product</span>
              <span className="w-14 text-right">Stock</span>
              <span className="w-14 text-right">In</span>
              <span className="w-14 text-right">Out</span>
              <span className="w-14 text-right">Ret</span>
              <span className="w-14 text-right">Adj</span>
            </div>
            {controlled.summary.map((c) => (
              <div key={c.name} className="flex items-center gap-2 border-b border-outline-variant/40 px-3 py-1.5 last:border-0">
                <span className={`min-w-0 flex-1 truncate ${td}`}>{c.name}</span>
                <span className="w-14 text-right font-data-mono text-data-mono font-bold text-on-surface">
                  {c.stock_qty}
                </span>
                <span className="w-14 text-right font-data-mono text-data-mono text-primary">
                  {c.received || "—"}
                </span>
                <span className="w-14 text-right font-data-mono text-data-mono text-error">
                  {c.dispensed || "—"}
                </span>
                <span className="w-14 text-right font-data-mono text-data-mono">
                  {c.returned || "—"}
                </span>
                <span className="w-14 text-right font-data-mono text-data-mono">
                  {c.adjusted || "—"}
                </span>
              </div>
            ))}
            {controlled.txns.length > 0 && (
              <div className="max-h-64 overflow-y-auto border-t border-outline-variant">
                {controlled.txns.slice(0, 80).map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 border-b border-outline-variant/40 px-3 py-1 last:border-0"
                  >
                    <span className="w-32 shrink-0 font-data-mono text-[11px] text-on-surface-variant">
                      {t.ts.slice(0, 16)}
                    </span>
                    <span
                      className={`w-20 shrink-0 rounded px-1 text-center text-[10px] font-bold ${kindCls(t.kind)}`}
                    >
                      {t.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body-sm text-on-surface">
                      {t.product}
                    </span>
                    <span className="w-16 shrink-0 text-right font-data-mono text-data-mono font-bold">
                      {t.qty > 0 ? `+${t.qty}` : t.qty}
                    </span>
                    <span className="w-28 shrink-0 truncate text-right text-[11px] text-on-surface-variant">
                      {t.ref ?? t.operator ?? ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {reprint && (
        <ReceiptModal
          result={reprint.result}
          lines={reprint.lines}
          subtotal={reprint.subtotal}
          tax={reprint.tax}
          paymentMethod={reprint.method}
          payments={reprint.payments}
          onClose={() => setReprint(null)}
        />
      )}
      {returnSale && (
        <ReturnModal
          sale={returnSale}
          onClose={() => setReturnSale(null)}
          onDone={() => {
            void refreshProducts();
            void load();
          }}
        />
      )}
    </div>
  );
}
