import { useCallback, useEffect, useMemo, useState } from "react";
import { initDb } from "../db";
import { fmtMoney } from "../lib/money";
import { PatientModal } from "../components/PatientModal";
import { ImportCustomersModal } from "../components/ImportCustomersModal";

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  discount_tier: number;
  visits: number;
  last_visit: string | null;
  credit_balance: number;
  dup_rows: number;
}

export function CustomersPage() {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [count, setCount] = useState(0);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<{ name: string; phone: string | null } | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await initDb();
      const term = q.trim();
      const like = term ? `%${term}%` : "%";
      const data = await db.select<CustomerRow[]>(
        `SELECT
           MIN(p.id) AS id,
           p.name,
           MAX(p.phone) AS phone,
           COALESCE(MAX(p.discount_tier), 0) AS discount_tier,
           COUNT(DISTINCT p.id) AS dup_rows,
           (SELECT COUNT(*) FROM sales s WHERE s.patient_name = p.name) AS visits,
           (SELECT MAX(timestamp) FROM sales s WHERE s.patient_name = p.name) AS last_visit,
           COALESCE(
             (SELECT COALESCE(SUM(sp.amount), 0)
              FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE sp.method = 'Credit' AND s.patient_name = p.name),
             0
           ) - COALESCE(
             (SELECT COALESCE(SUM(cp.amount), 0)
              FROM credit_payments cp WHERE cp.patient_name = p.name),
             0
           ) + COALESCE(MAX(p.opening_balance), 0) AS credit_balance
         FROM patients p
         WHERE p.name LIKE $1 OR p.phone LIKE $1
         GROUP BY p.name
         ORDER BY CASE WHEN last_visit IS NULL THEN 1 ELSE 0 END,
                  last_visit DESC,
                  p.name`,
        [like],
      );
      setRows(
        data.map((r) => ({
          ...r,
          discount_tier: Number(r.discount_tier) || 0,
          visits: Number(r.visits) || 0,
          dup_rows: Number(r.dup_rows) || 0,
          credit_balance: Number(r.credit_balance) || 0,
        })),
      );
      setCount(data.length);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => rows, [rows]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-outline-variant px-margin-page py-3">
        <div>
          <h2 className="text-title-lg font-title-lg font-medium text-on-surface">Customers</h2>
          <p className="text-body-sm text-on-surface-variant">
            {count} {count === 1 ? "person" : "people"} &middot; tap a row to view history &amp; edit
          </p>
        </div>
        <button
          onClick={() => setImporting(true)}
          className="flex h-9 items-center gap-2 rounded border border-outline-variant bg-surface-container-low px-3 text-label-md font-label-md text-on-surface hover:bg-surface-container-lowest"
        >
          <span className="material-symbols-outlined text-[18px]">upload</span>
          Import customers
        </button>
        <div className="relative min-w-[18rem]">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-outline">
            search
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or phone…"
            className="h-9 w-full rounded border border-outline-variant bg-surface-container-low pl-8 pr-3 text-body-sm placeholder-outline focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {err && (
        <div className="mx-margin-page mt-3 rounded bg-error-container px-3 py-2 text-body-sm text-on-error-container">
          {err}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-margin-page py-3">
        <div className="overflow-hidden rounded-xl border border-outline-variant">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="bg-surface-container-low text-left text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2 text-right">Discount</th>
                <th className="px-3 py-2 text-right">Visits</th>
                <th className="px-3 py-2">Last visit</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.name}
                  onClick={() => setSel({ name: c.name, phone: c.phone })}
                  className="cursor-pointer border-t border-outline-variant/60 hover:bg-surface-container-low"
                >
                  <td className="px-3 py-2 text-on-surface">
                    <span className="font-medium">{c.name}</span>
                    {c.dup_rows > 1 && (
                      <span
                        className="ml-2 rounded bg-tertiary-container px-1.5 py-0.5 text-[10px] font-medium text-on-tertiary-container"
                        title={`${c.dup_rows} records share this name — merge in the detail view`}
                      >
                        {c.dup_rows} dupes
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-data-mono text-data-mono text-on-surface-variant">
                    {c.phone ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-on-surface">
                    {c.discount_tier > 0 ? `${c.discount_tier}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-on-surface">{c.visits}</td>
                  <td className="px-3 py-2 text-on-surface-variant">
                    {c.last_visit ? c.last_visit.replace("T", " ").slice(0, 16) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {c.credit_balance > 0.005 ? (
                      <span className="font-medium text-error">{fmtMoney(c.credit_balance)}</span>
                    ) : (
                      <span className="text-on-surface-variant">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && !err && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-on-surface-variant">
                    No customers yet — they appear here automatically after a sale.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {sel && <PatientModal name={sel.name} phone={sel.phone} onClose={() => setSel(null)} />}
      {importing && (
        <ImportCustomersModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
