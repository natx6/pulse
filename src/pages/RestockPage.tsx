import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { stockStatus } from "../lib/stock";
import { fmtMoney } from "../lib/money";
import { beep } from "../lib/audio";
import { Tip } from "../components/Tip";
import {
  loadPurchaseOrders,
  loadPoItems,
  createPurchaseOrder,
  receivePo,
  type PurchaseOrder,
  type PoItem,
} from "../db";

type View = "stock" | "reqs";

function StatusPill({ po }: { po: PurchaseOrder }) {
  if (po.status === "received")
    return (
      <span className="rounded bg-surface-container-highest px-2 py-0.5 text-[11px] font-bold text-on-surface-variant">
        Received
      </span>
    );
  if (po.received_qty > 0)
    return (
      <span className="rounded bg-[#fef08a]/40 px-2 py-0.5 text-[11px] font-bold text-[#854d0e]">
        Partially Received ({po.received_qty}/{po.total_qty})
      </span>
    );
  return (
    <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
      Open
    </span>
  );
}

export function RestockPage() {
  const products = useStore((s) => s.products);
  const setIntakeOpen = useStore((s) => s.setIntakeOpen);
  const refreshProducts = useStore((s) => s.refreshProducts);

  const [view, setView] = useState<View>("stock");
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [detail, setDetail] = useState<{ po: PurchaseOrder; items: PoItem[] } | null>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [reqOpen, setReqOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const loadPos = async () => {
    setPos(await loadPurchaseOrders());
  };
  useEffect(() => {
    void loadPos();
  }, [view]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.barcode ?? "").includes(s) ||
        (p.supplier ?? "").toLowerCase().includes(s),
    );
  }, [products, q]);

  const openDetail = async (po: PurchaseOrder) => {
    const items = await loadPoItems(po.id);
    setDetail({ po, items });
    // Default each line to receiving everything still outstanding.
    setRecv(Object.fromEntries(items.map((it) => [it.id, String(it.qty - it.qty_received)])));
  };

  const doReceive = async () => {
    if (!detail) return;
    const lines = Object.entries(recv)
      .map(([id, v]) => ({ po_item_id: Number(id), qty: Number(v) || 0 }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) return;
    try {
      const r = await receivePo(detail.po.id, lines);
      await refreshProducts();
      await loadPos();
      setMsg(
        r.complete
          ? `${r.po_no} received — ${r.added} unit${r.added === 1 ? "" : "s"} added to stock.`
          : `${r.po_no}: received ${r.added} — the rest is still outstanding.`,
      );
      setDetail(null);
      beep(true);
      setTimeout(() => setMsg(""), 5000);
    } catch (e) {
      setMsg(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="mb-1 text-headline-lg font-headline-lg text-on-surface">
            Restocking
          </h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">
            Receive stock or raise requisitions to order more.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search inventory..."
            className="h-8 w-64 rounded border border-outline-variant bg-surface px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {view === "stock" ? (
            <Tip label="Receive stock — scan or enter a barcode (F2)" align="right">
              <button
                onClick={() => setIntakeOpen(true)}
                className="flex h-8 items-center gap-2 rounded bg-primary px-4 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
              >
                <span className="material-symbols-outlined text-[16px]">system_update_alt</span>
                <span className="text-label-md font-label-md">Inventory Intake</span>
              </button>
            </Tip>
          ) : (
            <Tip label="Create a purchase requisition" align="right">
              <button
                onClick={() => setReqOpen(true)}
                className="flex h-8 items-center gap-2 rounded bg-primary px-4 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
              >
                <span className="material-symbols-outlined text-[16px]">add_shopping_cart</span>
                <span className="text-label-md font-label-md">New Requisition</span>
              </button>
            </Tip>
          )}
        </div>
      </div>

      {msg && (
        <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
          {msg}
        </p>
      )}

      <div className="mb-3 flex w-fit overflow-hidden rounded border border-outline-variant">
        <button
          onClick={() => setView("stock")}
          className={`px-4 py-1.5 text-label-md font-label-md transition-colors ${
            view === "stock"
              ? "bg-primary text-on-primary"
              : "bg-surface text-on-surface hover:bg-surface-container-low"
          }`}
        >
          Stock
        </button>
        <button
          onClick={() => setView("reqs")}
          className={`px-4 py-1.5 text-label-md font-label-md transition-colors ${
            view === "reqs"
              ? "bg-primary text-on-primary"
              : "bg-surface text-on-surface hover:bg-surface-container-low"
          }`}
        >
          Requisitions
        </button>
      </div>

      {view === "stock" ? (
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface">
          <div className="flex items-center border-b border-outline-variant bg-surface-container-low px-4 py-2 text-label-md font-label-md text-on-surface-variant">
            <div className="w-12 text-center">In</div>
            <div className="flex-1">Medication Name / Barcode</div>
            <div className="w-32">Supplier</div>
            <div className="w-24 text-right">Qty</div>
            <div className="w-28 text-right">Cost</div>
            <div className="w-28 text-right">Retail</div>
            <div className="w-32 text-right">Status</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="p-8 text-center text-body-sm text-on-surface-variant">
                Nothing here yet. Use Inventory Intake to receive stock.
              </p>
            )}
            {filtered.map((p) => {
              const st = stockStatus(p);
              return (
                <div
                  key={p.id}
                  className="flex items-center border-b border-surface-variant bg-surface px-4 text-body-sm font-body-sm"
                  style={{ height: 36 }}
                >
                  <div className="flex w-12 justify-center">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        st === "critical"
                          ? "bg-error"
                          : st === "low"
                            ? "bg-[#eab308]"
                            : "bg-primary-container"
                      }`}
                    />
                  </div>
                  <div className="flex-1 truncate pr-4 font-data-mono text-data-mono text-on-surface">
                    {p.name}
                    <span className="ml-2 text-on-surface-variant">
                      {p.unit ? `${p.unit} · ` : ""}
                      {p.barcode ? `[${p.barcode}]` : "[no barcode]"}
                    </span>
                  </div>
                  <div className="w-32 truncate text-on-surface-variant">{p.supplier ?? "—"}</div>
                  <div className="w-24 pr-4 text-right font-data-mono text-data-mono">
                    {p.stock_qty}
                  </div>
                  <div className="w-28 pr-4 text-right font-data-mono text-data-mono">
                    {p.cost_price > 0 ? fmtMoney(p.cost_price) : "—"}
                  </div>
                  <div className="w-28 pr-4 text-right font-data-mono text-data-mono">
                    {fmtMoney(p.selling_price)}
                  </div>
                  <div className="w-32 text-right">
                    <span
                      className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                        st === "critical"
                          ? "bg-error-container text-on-error-container"
                          : st === "low"
                            ? "bg-[#fef08a]/20 text-[#854d0e]"
                            : "bg-surface-container-highest text-on-surface-variant"
                      }`}
                    >
                      {st === "critical"
                        ? p.stock_qty <= 0
                          ? "Out of Stock"
                          : "Expiring / Low"
                        : st === "low"
                          ? "Reorder"
                          : "OK"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface">
          <div className="flex items-center border-b border-outline-variant bg-surface-container-low px-4 py-2 text-label-md font-label-md text-on-surface-variant">
            <div className="w-36">Requisition No.</div>
            <div className="flex-1">Supplier</div>
            <div className="w-20 text-right">Items</div>
            <div className="w-32 text-right">Created</div>
            <div className="w-28 text-right">Status</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {pos.length === 0 && (
              <p className="p-8 text-center text-body-sm text-on-surface-variant">
                No requisitions yet. Create one to order stock.
              </p>
            )}
            {pos.map((po) => (
              <button
                key={po.id}
                onClick={() => void openDetail(po)}
                className="flex w-full items-center border-b border-surface-variant bg-surface px-4 text-body-sm font-body-sm transition-colors hover:bg-surface-container-low"
                style={{ height: 36 }}
              >
                <div className="w-36 truncate text-left font-data-mono text-data-mono text-on-surface">
                  {po.po_no}
                </div>
                <div className="flex-1 truncate pr-4 text-left text-on-surface-variant">
                  {po.supplier ?? "—"}
                </div>
                <div className="w-20 pr-4 text-right font-data-mono text-data-mono">
                  {po.item_count}
                </div>
                <div className="w-32 pr-4 text-right font-data-mono text-data-mono text-on-surface-variant">
                  {po.created_at}
                </div>
                <div className="w-28 text-right">
                  <StatusPill po={po} />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Requisition detail */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
            <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
              <div>
                <h3 className="text-headline-md font-headline-md text-on-surface">
                  {detail.po.po_no}
                </h3>
                <p className="text-body-sm font-body-sm text-on-surface-variant">
                  {detail.po.supplier ?? "No supplier"} · created {detail.po.created_at}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill po={detail.po} />
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
                const remaining = it.qty - it.qty_received;
                return (
                  <div
                    key={it.id}
                    className="flex items-center justify-between border-b border-outline-variant/50 py-2 last:border-0"
                  >
                    <div>
                      <p className="text-body-md font-semibold text-on-surface">
                        {it.product_name}
                      </p>
                      <p className="font-data-mono text-data-mono text-on-surface-variant">
                        {it.qty} ordered
                        {it.qty_received > 0 ? ` · ${it.qty_received} received` : ""}
                        {it.unit_cost ? ` · ${fmtMoney(it.unit_cost)} each` : ""}
                      </p>
                    </div>
                    {detail.po.status === "open" ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={remaining}
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
                    ) : (
                      <span className="font-data-mono text-data-mono font-bold text-on-surface">
                        {fmtMoney((it.unit_cost ?? 0) * it.qty)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container px-6 py-4">
              <button
                onClick={() => setDetail(null)}
                className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Close
              </button>
              {detail.po.status === "open" && (
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
      )}

      {reqOpen && (
        <RequisitionModal
          onClose={() => setReqOpen(false)}
          onCreated={async () => {
            setReqOpen(false);
            await loadPos();
            setMsg("Requisition created. When the goods arrive, open it and tap Receive.");
            setTimeout(() => setMsg(""), 5000);
          }}
        />
      )}
    </div>
  );
}

function RequisitionModal({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const products = useStore((s) => s.products);
  const [supplier, setSupplier] = useState("");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<
    { product_id: number; product_name: string; qty: number; unit_cost: number | null }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return products
      .filter((p) => p.name.toLowerCase().includes(s) || (p.barcode ?? "").includes(s))
      .slice(0, 6);
  }, [products, search]);

  const add = (productId: number, name: string) => {
    setLines((ls) =>
      ls.some((l) => l.product_id === productId)
        ? ls.map((l) => (l.product_id === productId ? { ...l, qty: l.qty + 1 } : l))
        : [...ls, { product_id: productId, product_name: name, qty: 1, unit_cost: null }],
    );
  };

  const create = async () => {
    if (lines.length === 0) {
      setErr("Add at least one product.");
      return;
    }
    setBusy(true);
    try {
      await createPurchaseOrder(supplier, lines);
      beep(true);
      await onCreated();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">
              New Requisition
            </h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              What do you need to order? Receive it later on this page.
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
          <label className="mb-3 block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Supplier
            </span>
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="e.g. McKesson, PharmaCorp (optional)"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="mb-2 block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Add products
            </span>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search catalog..."
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          {search.trim() && matches.length === 0 && (
            <p className="mb-2 text-body-sm text-on-surface-variant">No matches.</p>
          )}
          {matches.map((p) => (
            <button
              key={p.id}
              onClick={() => add(p.id, p.name)}
              className="flex w-full items-center justify-between border-b border-outline-variant/50 py-1.5 text-left hover:bg-surface-container-low"
            >
              <span className="text-body-sm text-on-surface">
                {p.name}
                {p.unit ? <span className="ml-1 text-on-surface-variant">({p.unit})</span> : null}
              </span>
              <span className="material-symbols-outlined text-[16px] text-primary">add</span>
            </button>
          ))}

          {lines.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                In this requisition
              </h4>
              {lines.map((l) => (
                <div
                  key={l.product_id}
                  className="flex items-center gap-2 border-b border-outline-variant/50 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-body-sm text-on-surface">
                    {l.product_name}
                  </span>
                  <input
                    value={l.qty}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x) =>
                          x.product_id === l.product_id
                            ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) }
                            : x,
                        ),
                      )
                    }
                    title="Quantity"
                    className="h-7 w-14 rounded border border-outline-variant bg-surface-container-lowest px-1 text-center font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                  />
                  <input
                    value={l.unit_cost ?? ""}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x) =>
                          x.product_id === l.product_id
                            ? { ...x, unit_cost: e.target.value ? Number(e.target.value) : null }
                            : x,
                        ),
                      )
                    }
                    placeholder="Cost"
                    title="Unit cost (optional)"
                    inputMode="decimal"
                    className="h-7 w-16 rounded border border-outline-variant bg-surface-container-lowest px-1 text-right font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none"
                  />
                  <button
                    onClick={() =>
                      setLines((ls) => ls.filter((x) => x.product_id !== l.product_id))
                    }
                    className="text-outline hover:text-error"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {err && <p className="mt-3 text-body-sm text-error">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={onClose}
            className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
          >
            Cancel
          </button>
          <button
            onClick={() => void create()}
            disabled={busy || lines.length === 0}
            className="rounded bg-primary px-6 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create Requisition"}
          </button>
        </div>
      </div>
    </div>
  );
}
