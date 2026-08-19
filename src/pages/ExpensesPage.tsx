import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import { beep } from "../lib/audio";
import {
  addExpense,
  listExpenses,
  expenseSummary,
  deleteExpense,
  EXPENSE_CATEGORIES,
  type Expense,
} from "../db";

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function ExpensesPage() {
  const operator = useStore((s) => s.operator);

  const [from, setFrom] = useState(fmt(new Date()));
  const [to, setTo] = useState(fmt(new Date()));
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<{ total: number; byCategory: { category: string; total: number }[] } | null>(null);

  // Add form
  const [cat, setCat] = useState("Other");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");

  const load = async () => {
    try {
      const [list, sum] = await Promise.all([listExpenses(from, to), expenseSummary(from, to)]);
      setExpenses(list);
      setSummary(sum);
    } catch {
      // Table may not exist yet if migration hasn't run.
    }
  };

  useEffect(() => {
    void load();
  }, [from, to]);

  const doAdd = async () => {
    const a = Number(amount);
    if (!a || a <= 0) return;
    setBusy(true);
    try {
      await addExpense({ category: cat, description: desc, amount: a, operator: operator || "" });
      beep(true);
      setFlash(`GH₵ ${a.toFixed(2)} recorded`);
      setTimeout(() => setFlash(""), 3000);
      setDesc("");
      setAmount("");
      await load();
    } catch (e) {
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const doDelete = async (id: number) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      window.setTimeout(() => setConfirmDel((c) => (c === id ? null : c)), 2500);
      return;
    }
    setConfirmDel(null);
    try {
      await deleteExpense(id);
      beep(true);
      await load();
    } catch (e) {
      beep(false);
    }
  };

  const field =
    "h-9 rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="mb-1 text-headline-lg font-headline-lg text-on-surface">Expenses</h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">
            Track petty cash, rent, utilities, and other running costs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={`${field} w-36`}
          />
          <span className="text-on-surface-variant">→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`${field} w-36`}
          />
        </div>
      </div>

      {/* Add expense form */}
      <div className="mb-4 flex items-end gap-3 rounded-xl border border-outline-variant bg-surface p-4">
        <label className="block">
          <span className="mb-1 block text-label-md font-label-md text-on-surface">Category</span>
          <select
            value={cat}
            onChange={(e) => setCat(e.target.value)}
            className={`${field} w-40`}
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex-1 block">
          <span className="mb-1 block text-label-md font-label-md text-on-surface">Description</span>
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="e.g. June electricity bill"
            className={`${field} w-full`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-label-md font-label-md text-on-surface">Amount (GH₵)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className={`${field} w-28 text-right font-data-mono text-data-mono`}
          />
        </label>
        <button
          onClick={() => void doAdd()}
          disabled={busy || !Number(amount) || Number(amount) <= 0}
          className="h-9 rounded bg-primary px-5 text-label-md font-label-md text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add"}
        </button>
        {flash && <span className="text-body-sm font-body-sm text-primary font-semibold">{flash}</span>}
      </div>

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Expense list */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface">
          <div className="flex items-center border-b border-outline-variant bg-surface-container-low px-4 py-2">
            <div className="flex-1 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">Date</div>
            <div className="w-28 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">Category</div>
            <div className="flex-1 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">Description</div>
            <div className="w-24 text-right font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">Amount</div>
            <div className="w-24 font-label-md font-label-md uppercase tracking-wider text-on-surface-variant">By</div>
            <div className="w-16" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {expenses.length === 0 && (
              <p className="p-8 text-center text-body-sm text-on-surface-variant">No expenses in this range.</p>
            )}
            {expenses.map((e) => (
              <div key={e.id} className="group flex items-center border-b border-outline-variant/50 px-4 py-1.5" style={{ height: 36 }}>
                <div className="flex-1 font-data-mono text-data-mono text-on-surface-variant">{e.timestamp?.slice(0, 10)}</div>
                <div className="w-28">
                  <span className="rounded bg-surface-container px-1.5 py-0.5 text-[10px] font-bold text-on-surface-variant">{e.category}</span>
                </div>
                <div className="flex-1 truncate text-body-sm text-on-surface">{e.description || "—"}</div>
                <div className="w-24 text-right font-data-mono text-data-mono font-bold text-on-surface">{fmtMoney(e.amount)}</div>
                <div className="w-24 text-body-sm text-on-surface-variant">{e.operator || "—"}</div>
                <div className="w-16 text-right">
                  <button
                    onClick={() => void doDelete(e.id)}
                    title={confirmDel === e.id ? "Click again to confirm" : "Delete this expense"}
                    className={`inline-flex h-6 items-center gap-0.5 rounded px-1 text-[10px] font-bold transition-colors ${
                      confirmDel === e.id
                        ? "bg-error/10 text-error"
                        : "text-outline opacity-0 transition-opacity hover:bg-error/10 hover:text-error group-hover:opacity-100"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]">delete</span>
                    {confirmDel === e.id && <span>Delete?</span>}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex h-10 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container-low px-4">
            <span className="text-body-sm text-on-surface-variant">{expenses.length} expense{expenses.length === 1 ? "" : "s"}</span>
            <span className="font-data-mono text-data-mono font-bold text-primary">Total: {fmtMoney(summary?.total ?? 0)}</span>
          </div>
        </div>

        {/* Category breakdown */}
        <div className="w-64 shrink-0 overflow-hidden rounded-lg border border-outline-variant bg-surface">
          <h3 className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md font-bold text-on-surface">
            By Category
          </h3>
          {summary && summary.byCategory.length === 0 && (
            <p className="px-3 py-4 text-center text-body-sm text-on-surface-variant">No expenses.</p>
          )}
          {summary?.byCategory.map((c) => (
            <div key={c.category} className="flex items-center justify-between border-b border-outline-variant/50 px-3 py-1.5 last:border-0">
              <span className="text-body-sm text-on-surface">{c.category}</span>
              <span className="font-data-mono text-data-mono font-bold text-on-surface">{fmtMoney(c.total)}</span>
            </div>
          ))}
          {summary && summary.byCategory.length > 0 && (
            <div className="flex items-center justify-between border-t border-outline-variant bg-surface-container-low px-3 py-2">
              <span className="text-label-md font-label-md font-bold text-on-surface">Total</span>
              <span className="font-data-mono text-data-mono font-bold text-primary">{fmtMoney(summary.total)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
