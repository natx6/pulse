import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import { beep } from "../lib/audio";
import { Tip } from "../components/Tip";
import { PurchaseModal } from "../components/PurchaseModal";
import { PrintPOModal } from "../components/PrintPOModal";
import { PurchasePaymentModal } from "../components/PurchasePaymentModal";
import {
  cancelPurchase,
  loadPurchases,
  loadPurchaseItems,
  receivePurchase,
  type Purchase,
  type PurchaseItem,
} from "../db";

function StatusPill({ p }: { p: Purchase }) {
  if (p.status === "Received")
    return (
      <span className="rounded bg-success-subtle px-2 py-0.5 text-[11px] font-bold text-success">
        Received
      </span>
    );
  if (p.received_qty > 0)
    return (
      <span className="rounded bg-warn-muted px-2 py-0.5 text-[11px] font-bold text-warn">
        Partially Received ({p.received_qty}/{p.total_qty})
      </span>
    );
  if (p.status === "Ordered")
    return (
      <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
        Ordered
      </span>
    );
  return (
    <span className="rounded bg-surface-container-highest px-2 py-0.5 text-[11px] font-bold text-on-surface-variant">
      Draft
    </span>
  );
}

/** Requisitions: orders placed with suppliers (and the invoices that come
 * back). Saving as Received lands the goods in stock immediately; Ordered/
 * Draft orders can be edited, cancelled, printed, and received from the
 * detail view when the delivery arrives. */
export function RestockPage() {
  const refreshProducts = useStore((s) => s.refreshProducts);
  const highlight = useStore((s) => s.highlight);
  const setHighlight = useStore((s) => s.setHighlight);

  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [detail, setDetail] = useState<{ p: Purchase; items: PurchaseItem[] } | null>(null);
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [inv, setInv] = useState<Record<string, string>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [editing, setEditing] = useState<{ p: Purchase; items: PurchaseItem[] } | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [cancelArm, setCancelArm] = useState(false);
  const [msg, setMsg] = useState("");
  const [warn, setWarn] = useState("");
  const [detailErr, setDetailErr] = useState("");
  const flashRef = useRef<HTMLButtonElement>(null);

  // When arriving from a notification deep-link, scroll the targeted purchase
  // into view and blink it for a moment.
  useEffect(() => {
    if (highlight?.kind !== "purchase") return;
    flashRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const clear = window.setTimeout(() => setHighlight(null), 1500);
    return () => window.clearTimeout(clear);
  }, [highlight, setHighlight]);

  const load = async () => {
    const rows = await loadPurchases();
    setPurchases(rows);
    return rows;
  };
  useEffect(() => {
    void load();
  }, []);

  const openDetail = async (p: Purchase) => {
    const items = await loadPurchaseItems(p.id);
    setDetail({ p, items });
    setPrintOpen(false);
    setPayOpen(false);
    setCancelArm(false);
    setWarn("");
    setDetailErr("");
    // Default each line to receiving everything still outstanding, with the
    // ordered unit cost pre-filled as the invoice cost to compare against.
    setRecv(Object.fromEntries(items.map((it) => [it.id, String(it.quantity - it.qty_received)])));
    setInv(Object.fromEntries(items.map((it) => [it.id, String(it.unit_cost_net)])));
  };

  const doReceive = async () => {
    if (!detail) return;
    setWarn("");
    setDetailErr("");
    const lines = Object.entries(recv)
      .map(([id, v]) => {
        const item = detail.items.find((it) => it.id === id);
        const remaining = item ? item.quantity - item.qty_received : 0;
        const ic = Number(inv[id]);
        return {
          line_id: id,
          // Never trust the raw input past what's actually still outstanding —
          // the max={remaining} on the field is a hint, not an enforcement.
          qty: Math.min(Math.max(0, Number(v) || 0), remaining),
          // Skip the invoice-cost check when the field was cleared.
          invoice_cost: Number.isFinite(ic) && ic > 0 ? ic : null,
        };
      })
      .filter((l) => l.qty > 0);
    if (lines.length === 0) return;
    try {
      const r = await receivePurchase(detail.p.id, lines);
      await refreshProducts();
      await load();
      const done = r.complete
        ? `${r.reference_no} received — ${r.added} unit${r.added === 1 ? "" : "s"} added to stock.`
        : `${r.reference_no}: received ${r.added} — the rest is still outstanding.`;
      if (r.warnings.length > 0) {
        setWarn(
          `${r.warnings.length} line${r.warnings.length === 1 ? "" : "s"} invoiced at a different cost than ordered — check before paying: ${r.warnings.join(" · ")}`,
        );
      }
      setMsg(done);
      setDetail(null);
      beep(true);
      setTimeout(() => {
        setMsg("");
        setWarn("");
      }, 8000);
    } catch (e) {
      // Shown inside the still-open modal, not the page-level `msg` banner —
      // that banner sits behind this modal's backdrop and would be invisible.
      setDetailErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  /** Two-step cancel: only Draft/Ordered, never Received. Cancelled orders
   * drop out of the list and the bell. */
  const doCancel = async () => {
    if (!detail) return;
    setDetailErr("");
    try {
      await cancelPurchase(detail.p.id, null);
      await load();
      setMsg(`${detail.p.reference_no ?? detail.p.id} cancelled.`);
      setDetail(null);
      beep(true);
      setTimeout(() => setMsg(""), 5000);
    } catch (e) {
      setDetailErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="mb-1 text-headline-lg font-headline-lg text-on-surface" data-tour="tour-restock">Requisitions</h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">
            What we've ordered from suppliers. Save as Received to add goods to
            stock in one transaction — or save an order, print it, and receive
            it here when it arrives.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tip label="Record a supplier invoice or order" align="right">
            <button
              onClick={() => setNewOpen(true)}
              className="flex h-8 items-center gap-2 rounded bg-primary px-4 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
            >
              <span className="material-symbols-outlined text-[16px]">add_shopping_cart</span>
              <span className="text-label-md font-label-md">New Purchase</span>
            </button>
          </Tip>
        </div>
      </div>

      {msg && (
        <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
          {msg}
        </p>
      )}
      {warn && (
        <p className="mb-3 rounded border border-warn/50 bg-warn-subtle px-3 py-2 text-body-sm font-body-sm text-warn">
          {warn}
        </p>
      )}

      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface">
        <div className="flex items-center border-b border-outline-variant bg-surface-container-low px-4 py-2 text-label-md font-label-md text-on-surface-variant">
          <div className="w-44">Reference</div>
          <div className="flex-1">Supplier</div>
          <div className="w-16 text-right">Items</div>
          <div className="w-32 text-right">Date</div>
          <div className="w-28 text-right">Total</div>
          <div className="w-24 text-right">Pay term</div>
          <div className="w-28 text-right">Status</div>
          <div className="w-24 text-right">Balance</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {purchases.length === 0 && (
            <p className="p-8 text-center text-body-sm text-on-surface-variant">
              No purchases yet. Record a supplier invoice to bring stock in.
            </p>
          )}
          {purchases.map((p) => (
            <button
              key={p.id}
              ref={highlight?.kind === "purchase" && highlight.id === p.id ? flashRef : undefined}
              onClick={() => void openDetail(p)}
              className={`flex w-full items-center border-b border-surface-variant bg-surface px-4 text-body-sm font-body-sm transition-colors hover:bg-surface-container-low ${
                highlight?.kind === "purchase" && highlight.id === p.id ? "flash-row" : ""
              }`}
              style={{ height: 36 }}
            >
              <div className="w-44 truncate text-left font-data-mono text-data-mono text-on-surface">
                {p.reference_no ?? p.id}
              </div>
              <div className="flex-1 truncate pr-4 text-left text-on-surface-variant">
                {p.supplier_name ?? "—"}
              </div>
              <div className="w-16 pr-4 text-right font-data-mono text-data-mono">
                {p.item_count}
              </div>
              <div className="w-32 pr-4 text-right font-data-mono text-data-mono text-on-surface-variant">
                {p.purchase_date}
              </div>
              <div className="w-28 pr-4 text-right font-data-mono text-data-mono font-bold text-on-surface">
                {fmtMoney(p.total_amount)}
              </div>
              <div className="w-24 pr-4 text-right text-on-surface-variant">{p.pay_term ?? "—"}</div>
              <div className="w-28 text-right">
                <StatusPill p={p} />
              </div>
              <div className="w-24 pr-4 text-right font-data-mono text-data-mono">
                {p.status === "Received" || p.paid_amount > 0 ? (
                  p.paid_amount >= p.total_amount ? (
                    <span className="text-success">Paid</span>
                  ) : (
                    fmtMoney(p.total_amount - p.paid_amount)
                  )
                ) : (
                  "—"
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Purchase detail / receive */}
      {detail && (
        <div data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
            <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
              <div>
                <h3 className="text-headline-md font-headline-md text-on-surface">
                  {detail.p.reference_no ?? detail.p.id}
                </h3>
                <p className="text-body-sm font-body-sm text-on-surface-variant">
                  {detail.p.supplier_name ?? "No supplier"} · {detail.p.purchase_date} ·{" "}
                  {detail.p.pay_term ?? "Cash"}
                  {detail.p.discount_type !== "None"
                    ? ` · discount ${detail.p.discount_type === "Fixed" ? fmtMoney(detail.p.discount_amount) : `${detail.p.discount_amount}%`}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill p={detail.p} />
                {detail.p.status !== "Received" && detail.p.received_qty === 0 && (
                  <>
                    <button
                      onClick={() => setEditing({ p: detail.p, items: detail.items })}
                      className="flex items-center gap-1 rounded border border-outline px-2 py-1 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                    >
                      <span className="material-symbols-outlined text-[14px]">edit</span>
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (cancelArm) {
                          void doCancel();
                        } else {
                          setCancelArm(true);
                          setTimeout(() => setCancelArm(false), 4000);
                        }
                      }}
                      className={`flex items-center gap-1 rounded border px-2 py-1 text-label-md font-label-md hover:bg-surface-variant ${
                        cancelArm ? "border-error text-error" : "border-outline text-on-surface"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                      {cancelArm ? "Confirm cancel?" : "Cancel"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => setDetail(null)}
                  className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {detail.items.map((it) => {
                const remaining = it.quantity - it.qty_received;
                return (
                  <div
                    key={it.id}
                    className="flex items-center justify-between border-b border-outline-variant/50 py-2 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-body-md font-semibold text-on-surface">
                        {it.product_name}
                      </p>
                      <p className="font-data-mono text-data-mono text-on-surface-variant">
                        {it.quantity} × {fmtMoney(it.unit_cost_net)} · sells at{" "}
                        {fmtMoney(it.unit_selling_price)}
                        {it.profit_margin_percent !== null
                          ? ` · ${it.profit_margin_percent.toFixed(1)}% margin`
                          : ""}
                        {it.expiry_date ? ` · exp ${it.expiry_date}` : ""}
                        {it.qty_received > 0 ? ` · ${it.qty_received} received` : ""}
                      </p>
                    </div>
                    {detail.p.status !== "Received" ? (
                      <div className="flex items-center gap-3">
                        <label
                          className="flex items-center gap-1"
                          title="Unit cost on the supplier's invoice — compared against the ordered cost when you receive"
                        >
                          <span className="text-[11px] text-on-surface-variant">Invoice cost</span>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={inv[it.id] ?? String(it.unit_cost_net)}
                            onChange={(e) =>
                              setInv((r) => ({ ...r, [it.id]: e.target.value }))
                            }
                            className="h-7 w-20 rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                          />
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={remaining}
                            step="any"
                            value={recv[it.id] ?? String(remaining)}
                            onChange={(e) =>
                              setRecv((r) => ({ ...r, [it.id]: e.target.value }))
                            }
                            title={`Receiving now (max ${remaining})`}
                            className="h-7 w-16 rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                          />
                          <span className="text-[11px] text-on-surface-variant">
                            of {remaining} left
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span className="font-data-mono text-data-mono font-bold text-on-surface">
                        {fmtMoney(it.line_total)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {detailErr && (
              <p className="mx-4 mb-2 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
                {detailErr}
              </p>
            )}
            <div className="flex items-center justify-between border-t border-outline-variant bg-surface-container px-6 py-4">
              <div>
                <p className="font-data-mono text-data-mono text-on-surface">
                  Net total{" "}
                  <span className="text-headline-md font-headline-md font-bold text-primary">
                    {fmtMoney(detail.p.total_amount)}
                  </span>
                </p>
                <p className="text-body-sm text-on-surface-variant">
                  Paid {fmtMoney(detail.p.paid_amount)}
                  {detail.p.paid_amount >= detail.p.total_amount
                    ? " · Fully paid"
                    : ` · Balance ${fmtMoney(detail.p.total_amount - detail.p.paid_amount)}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPrintOpen(true)}
                  className="flex items-center gap-2 rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined text-[18px]">print</span>
                  Print order
                </button>
                <button
                  onClick={() => setDetail(null)}
                  className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
                >
                  Close
                </button>
                {detail.p.paid_amount < detail.p.total_amount && (
                  <button
                    onClick={() => setPayOpen(true)}
                    className="flex items-center gap-2 rounded border border-primary/40 bg-primary/5 px-4 py-2 text-label-md font-label-md text-primary hover:bg-primary/10"
                  >
                    <span className="material-symbols-outlined text-[18px]">payments</span>
                    Record payment
                  </button>
                )}
                {detail.p.status !== "Received" && (
                  <Tip label="Add the received quantities to stock — one transaction">
                    <button
                      onClick={() => void doReceive()}
                      className="flex items-center gap-2 rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
                    >
                      <span className="material-symbols-outlined text-[18px]">inventory_2</span>
                      Receive & Add to Stock
                    </button>
                  </Tip>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {printOpen && detail && (
        <PrintPOModal p={detail.p} items={detail.items} onClose={() => setPrintOpen(false)} />
      )}

      {editing && (
        <PurchaseModal
          edit={editing}
          onClose={() => setEditing(null)}
          onSaved={async (r) => {
            setEditing(null);
            setDetail(null);
            await load();
            setMsg(
              `${r.id} updated — ${r.items} line${r.items === 1 ? "" : "s"} (${fmtMoney(r.total)}).`,
            );
            setTimeout(() => setMsg(""), 6000);
          }}
        />
      )}

      {payOpen && detail && (
        <PurchasePaymentModal
          p={detail.p}
          onClose={() => setPayOpen(false)}
          onPaid={async (r) => {
            setPayOpen(false);
            const fresh = await load();
            const upd = fresh.find((x) => x.id === detail.p.id);
            if (upd) setDetail((d) => (d ? { p: upd, items: d.items } : d));
            setMsg(
              `${r.reference_no ?? detail.p.id}: ${fmtMoney(r.paid)} paid${
                r.balance > 0 ? ` — ${fmtMoney(r.balance)} left` : " — fully paid"
              }.`,
            );
            setTimeout(() => setMsg(""), 6000);
          }}
        />
      )}

      {newOpen && (
        <PurchaseModal
          onClose={() => setNewOpen(false)}
          onSaved={async (r) => {
            setNewOpen(false);
            await refreshProducts();
            await load();
            setMsg(
              r.received
                ? `${r.id} saved — ${r.items} line${r.items === 1 ? "" : "s"} added to stock (${fmtMoney(r.total)}).`
                : `${r.id} saved as an order (${fmtMoney(r.total)}). Receive it when the goods arrive.`,
            );
            setTimeout(() => setMsg(""), 6000);
          }}
        />
      )}
    </div>
  );
}
