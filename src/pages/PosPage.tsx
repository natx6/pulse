import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";
import { fmtMoney } from "../lib/money";
import { stockStatus } from "../lib/stock";
import { initDb, savePurchase } from "../db";
import type { PaymentLine, PaymentMethod, Product, SaleResult } from "../types";
import { PaymentModal } from "../components/PaymentModal";
import { ReceiptModal } from "../components/ReceiptModal";
import { AddCustomerModal } from "../components/AddCustomerModal";
import { Tip } from "../components/Tip";
import { useToast } from "../store/toast";
import { getPatientDiscount } from "../db";
import { useFocusTrap } from "../lib/focusTrap";

function StatusBadge({ p }: { p: Product }) {
  const st = stockStatus(p);
  if (st === "critical")
    return (
      <span className="rounded border border-error/30 bg-error-container px-1.5 text-[10px] font-bold text-on-error-container">
        Critical · {p.stock_qty}
      </span>
    );
  if (st === "low")
    return (
      <span className="rounded border border-warn bg-warn-muted px-1.5 text-[10px] font-bold text-warn">
        Low · {p.stock_qty}
      </span>
    );
  return (
    <span className="rounded border border-primary/30 bg-primary/10 px-1.5 text-[10px] text-primary">
      {p.stock_qty} in stock
    </span>
  );
}

export function PosPage() {
  const products = useStore((s) => s.products);
  const cart = useStore((s) => s.cart);
  const addToCart = useStore((s) => s.addToCart);
  const setQty = useStore((s) => s.setQty);
  const removeLine = useStore((s) => s.removeLine);
  const setPatient = useStore((s) => s.setPatient);
  const patient = useStore((s) => s.patient);
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearch = useStore((s) => s.setSearch);
  const taxRate = useStore((s) => s.taxRate);
  const setPage = useStore((s) => s.setPage);
  const heldCart = useStore((s) => s.heldCart);
  const holdOrder = useStore((s) => s.holdOrder);
  const restoreHeld = useStore((s) => s.restoreHeld);
  const refreshProducts = useStore((s) => s.refreshProducts);
  const setQuickAdd = useStore((s) => s.setQuickAdd);

  const [category, setCategory] = useState("All Categories");
  const [payMethod, setPayMethod] = useState<PaymentMethod | null>(null);
  const [reorder, setReorder] = useState<Product | null>(null);
  const [orderQty, setOrderQty] = useState(10);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderErr, setOrderErr] = useState("");
  const [flash, setFlash] = useState("");
  const [lastMethod, setLastMethod] = useState<PaymentMethod | null>(null);
  const [selectedPay, setSelectedPay] = useState<PaymentMethod | null>(null);
  const [lastSale, setLastSale] = useState<{
    result: SaleResult;
    lines: { productId: number; name: string; unit: string | null; unitPrice: number; qty: number }[];
    subtotal: number;
    discountPct: number;
    discountAmt: number;
    tax: number;
    method: string;
    payments: PaymentLine[];
  } | null>(null);
  const [patientInput, setPatientInput] = useState("");
  const [patientHits, setPatientHits] = useState<{ id: number; name: string; phone: string | null }[]>([]);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  /** Per-line "step by whole packs" toggle for products with pack_size > 1. */
  const [packStep, setPackStep] = useState<Record<number, boolean>>({});
  const reorderDialogRef = useFocusTrap<HTMLDivElement>();

  // Live patient suggestions while typing the customer name (click to attach).
  useEffect(() => {
    const q = patientInput.trim();
    if (!q) {
      setPatientHits([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await initDb();
        const rows = await d.select<{ name: string; phone: string | null; id: number }[]>(
          "SELECT id, name, phone FROM patients WHERE name LIKE $1 OR phone LIKE $1 ORDER BY name LIMIT 6",
          [`%${q}%`],
        );
        if (!cancelled) setPatientHits(rows);
      } catch {
        if (!cancelled) setPatientHits([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientInput]);

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category).filter(Boolean))) as string[],
    [products],
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== "All Categories" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.barcode ?? "").includes(q) ||
        (p.manufacturer ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, searchQuery, category]);

  const [discountPct, setDiscountPct] = useState(0);

  // Fetch patient discount tier when patient changes.
  useEffect(() => {
    if (!patient?.name) { setDiscountPct(0); return; }
    let cancelled = false;
    void (async () => {
      try {
        const d = await getPatientDiscount(patient.name);
        if (!cancelled) setDiscountPct(d);
      } catch { if (!cancelled) setDiscountPct(0); }
    })();
    return () => { cancelled = true; };
  }, [patient?.name]);

  /** Current catalog stock for a cart line, so quantity controls can't be
   * pushed past what's actually on the shelf. */
  const stockFor = (productId: number): number | undefined =>
    products.find((p) => p.id === productId)?.stock_qty;

  const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const discountAmt = subtotal * (discountPct / 100);
  const afterDiscount = subtotal - discountAmt;
  const tax = (afterDiscount * taxRate) / 100;
  const total = afterDiscount + tax;

  const onSearchEnter = () => {
    const q = searchQuery.trim();
    if (!q) return;
    const st = useStore.getState();
    const p = st.products.find((x) => x.barcode === q);
    if (p) {
      // Delegate to tryAdd so the out-of-stock/at-cart-max checks can never
      // drift from the product-grid add path — a repeat scan past available
      // stock must not play the success beep for a cart that didn't change.
      if (tryAdd(p)) setSearch("");
    } else if (q.length >= 6 && /^[0-9]+$/.test(q)) {
      // looks like an unknown barcode → quick add
      beep(false);
      useToast.getState().show(`Unknown barcode ${q} — quick add`, "info");
      st.setQuickAdd({ barcode: q });
      setSearch("");
    }
  };

  const onSaleComplete = async (r: SaleResult, payments: PaymentLine[]) => {
    setLastSale({
      result: r,
      lines: [...cart],
      subtotal,
      discountPct,
      discountAmt,
      tax,
      method: payments.map((p) => p.method).join(" + "),
      payments,
    });
    setPayMethod(null);
    // Remember the primary method so the next "Complete Sale" opens the same one.
    const used = payments[0]?.method ?? null;
    setLastMethod(used);
    setSelectedPay(used);
    useStore.getState().clearCart();
    useStore.getState().setPatient(null);
    await refreshProducts();
  };

  /** Adds to the cart if there's room; returns whether it actually did, so
   * callers (e.g. the barcode-scan path) know whether the add was real or
   * silently blocked at the stock cap. `asPack` adds a whole purchase pack
   * (carton) — pack_size sell units in one tap. */
  const tryAdd = (p: Product, asPack = false): boolean => {
    if (p.stock_qty <= 0) {
      beep(false);
      useToast.getState().show(`${p.name} is out of stock`, "error");
      return false;
    }
    const units = asPack ? Math.max(1, p.pack_size ?? 1) : 1;
    const line = cart.find((l) => l.productId === p.id);
    const want = (line?.qty ?? 0) + units;
    if (want > p.stock_qty) {
      beep(false);
      useToast.getState().show(
        asPack
          ? `Only ${p.stock_qty} of ${p.name} in stock — a whole ${p.unit ?? "pack"} won't fit`
          : `Max stock reached for ${p.name}`,
        "error",
      );
      return false;
    }
    addToCart(p, units);
    beep(true);
    useToast.getState().show(`${p.name} added`, "success", { duration: 1500 });
    return true;
  };

  const doReorder = async () => {
    if (!reorder || orderBusy) return;
    setOrderBusy(true);
    try {
      const r = await savePurchase({
        supplier_id: null,
        supplier_name: null,
        reference_no: null,
        purchase_date: new Date().toISOString().slice(0, 10),
        pay_term: "Cash",
        status: "Ordered",
        discount_type: "None",
        discount_amount: 0,
        lines: [
          {
            product_id: reorder.id,
            product_name: reorder.name,
            unit_type: "Pack",
            quantity: orderQty,
            unit_cost_raw: reorder.cost_price ?? 0,
            discount_percent: 0,
            unit_selling_price: reorder.selling_price ?? 0,
            expiry_date: reorder.expiry_date ?? "",
            batch_no: null,
          },
        ],
      });
      beep(true);
      setReorder(null);
      setFlash(`${r.id} created — receive it in Requisitions.`);
      setTimeout(() => setFlash(""), 6000);
    } catch (e) {
      setOrderErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setOrderBusy(false);
    }
  };

  const startCheckout = (m: PaymentMethod) => {
    if (cart.length === 0) {
      beep(false);
      return;
    }
    const st = useStore.getState();
    if (st.quickAdd || st.intakeOpen) return;
    setSelectedPay(m);
    setPayMethod(m);
  };

  const doClearCart = () => {
    if (cart.length === 0) return;
    const snapshot = [...cart];
    useStore.getState().clearCart();
    useToast.getState().show("Cart cleared", "info", {
      duration: 5000,
      undo: () => {
        useStore.setState({ cart: snapshot });
      },
    });
  };

  useEffect(() => {
    document.getElementById("pos-search")?.focus();
  }, []);

  // F9/F10/F11: quick checkout from the POS screen (no-op while a modal is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (payMethod) return; // payment modal open — it handles F9/10/11 itself
      if (e.key === "F9") {
        e.preventDefault();
        startCheckout("Cash");
      } else if (e.key === "F10") {
        e.preventDefault();
        startCheckout("Card");
      } else if (e.key === "F11") {
        e.preventDefault();
        startCheckout("MoMo");
      } else if (e.key === "F8") {
        e.preventDefault();
        if (useStore.getState().cart.length === 0) return;
        holdOrder();
        useToast.getState().show("Order held", "info");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payMethod, cart.length]);

  return (
    <div className="flex h-full gap-density-medium bg-surface-container-low p-density-medium">
      {/* Left: search + product grid */}
      <section className="flex flex-1 flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-sm">
        <div className="flex items-center gap-4 border-b border-outline-variant bg-surface-container-lowest p-4">
          <div className="relative flex flex-1 items-center">
            <span className="material-symbols-outlined absolute left-3 text-outline">
              barcode_scanner
            </span>
            <input
              id="pos-search"
              value={searchQuery}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSearchEnter()}
              placeholder="Scan barcode or search medication (e.g. Amoxicillin 500mg)"
              className="h-10 w-full rounded border border-outline-variant bg-surface pl-10 pr-4 font-data-mono text-data-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="absolute right-3 flex gap-1">
              <span className="rounded border border-outline-variant bg-surface-container-low px-1 text-shortcut-hint font-shortcut-hint text-on-surface-variant">
                Ctrl
              </span>
              <span className="rounded border border-outline-variant bg-surface-container-low px-1 text-shortcut-hint font-shortcut-hint text-on-surface-variant">
                F
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-10 rounded border border-outline-variant bg-surface px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
            >
              <option>All Categories</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <p className="mt-8 text-center text-body-md font-body-md text-on-surface-variant">
              No products found. Scan a new barcode to create one, or check Inventory.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Add ${p.name} to sale`}
                  onClick={() => tryAdd(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      tryAdd(p);
                    }
                  }}
                  className="group relative flex min-h-[120px] cursor-pointer flex-col justify-between rounded border border-outline-variant bg-surface-container-lowest p-3 transition-colors hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <div>
                    <div className="mb-1 flex items-start justify-between">
                      <h3 className="line-clamp-2 text-label-md font-label-md font-bold text-on-surface">
                        {p.name}
                      </h3>
                      <span className="ml-2 flex shrink-0 items-center gap-1">
                        <span
                          className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            p.rx_flag
                              ? "bg-primary-container text-on-primary-container"
                              : "bg-surface-variant text-on-surface-variant"
                          }`}
                        >
                          {p.rx_flag ? "Rx" : "OTC"}
                        </span>
                        {p.is_controlled ? (
                          <span
                            className="whitespace-nowrap rounded bg-danger-deep px-1.5 py-0.5 text-[10px] font-bold text-white"
                            title="Controlled drug — see the register in Reports"
                          >
                            C
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <p className="mb-2 font-data-mono text-data-mono text-on-surface-variant">
                      {p.strength || "—"}
                      {p.unit ? ` • ${p.unit}` : ""}
                    </p>
                    <div className="mb-2 flex gap-1">
                      {p.manufacturer && (
                        <span className="rounded border border-outline-variant/30 bg-surface-container px-1.5 text-[10px] text-on-surface-variant">
                          {p.manufacturer}
                        </span>
                      )}
                      <StatusBadge p={p} />
                    </div>
                  </div>
                  <div className="mt-auto flex items-end justify-between border-t border-outline-variant/30 pt-2">
                    <span className="font-data-mono text-data-mono font-bold text-on-surface">
                      {fmtMoney(p.selling_price)}
                    </span>
                    <div className="flex items-center gap-1">
                      {stockStatus(p) !== "in" && (
                        <Tip label="Order more of this item — receive it later in Requisitions">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setReorder(p);
                              setOrderQty(p.reorder_level > 0 ? p.reorder_level : 10);
                              setOrderErr("");
                            }}
                            className="flex h-6 items-center gap-1 rounded bg-warn-soft px-2 text-[10px] font-bold text-warn transition-colors hover:bg-warn-soft"
                          >
                            <span className="material-symbols-outlined text-[13px]">add_shopping_cart</span>
                            Order
                          </button>
                        </Tip>
                      )}
                      <Tip label="Add to cart">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            tryAdd(p);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded bg-primary/10 text-primary opacity-0 transition-opacity hover:bg-primary hover:text-white group-hover:opacity-100"
                        >
                          <span className="material-symbols-outlined text-[16px]">add</span>
                        </button>
                      </Tip>
                      {(p.pack_size ?? 1) > 1 && (
                        <Tip label={`Add a whole pack — ${p.pack_size} × ${p.unit ?? "unit"}`}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              tryAdd(p, true);
                            }}
                            className="flex h-6 items-center gap-0.5 rounded bg-secondary-container px-1.5 text-[10px] font-bold text-on-secondary-container opacity-0 transition-opacity hover:brightness-95 group-hover:opacity-100"
                          >
                            <span className="material-symbols-outlined text-[13px]">inventory_2</span>
                            ×{p.pack_size}
                          </button>
                        </Tip>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex h-12 items-center justify-between border-t border-outline-variant bg-surface px-4">
          <span className="flex items-center gap-1 text-body-sm font-body-sm">
            {flash ? (
              <>
                <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>
                <span className="font-semibold text-primary">{flash}</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[16px]">info</span>
                {filtered.length} item{filtered.length === 1 ? "" : "s"} shown. F8 = hold · F9/F10/F11 = checkout.
              </>
            )}
          </span>
          <button
            onClick={() => setPage("inventory")}
            className="rounded px-2 py-1 text-label-md font-label-md text-primary transition-colors hover:bg-surface-container-low"
          >
            View Catalog
          </button>
        </div>
      </section>

      {/* Right: cart */}
      <section className="flex w-96 flex-shrink-0 flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low p-3">
          {patient ? (
            <div className="flex items-center gap-2 rounded p-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary-container text-body-sm font-bold text-on-secondary-container">
                {patient.name
                  .split(" ")
                  .map((s) => s[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </div>
              <div>
                <h4 className="text-label-md font-label-md text-on-surface">{patient.name}</h4>
                <p className="font-data-mono text-[10px] text-on-surface-variant">
                  {patient.phone || "No phone"}
                </p>
              </div>
              <Tip label="Clear the patient — walk-in">
                <button
                  onClick={() => setPatient(null)}
                  className="ml-1 flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined text-[18px]">person_remove</span>
                </button>
              </Tip>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  value={patientInput}
                  onChange={(e) => setPatientInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && patientInput.trim()) {
                      setPatient({ name: patientInput.trim(), phone: "" });
                      setPatientInput("");
                      setPatientHits([]);
                    }
                  }}
                  placeholder="Patient name (Enter to attach)"
                  className="h-8 w-full rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
                {patientInput.trim() && patientHits.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setPatientHits([])} />
                    <div className="absolute left-0 right-0 top-9 z-50 overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-lg">
                      {patientHits.map((h) => (
                        <button
                          key={h.id}
                          onClick={() => {
                            setPatient({ name: h.name, phone: h.phone ?? "" });
                            setPatientInput("");
                            setPatientHits([]);
                          }}
                          className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-surface-container-low"
                        >
                          <span className="truncate text-body-sm text-on-surface">{h.name}</span>
                          <span className="ml-2 shrink-0 font-data-mono text-[11px] text-on-surface-variant">
                            {h.phone ?? "—"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <Tip label="Register a new customer">
                <button
                  onClick={() => setShowAddCustomer(true)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-primary transition-colors hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined text-[18px]">person_add</span>
                </button>
              </Tip>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-outline-variant/50 bg-surface px-4 py-2">
          <span className="text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
            Current Order
          </span>
          {cart.length > 0 && (
            <Tip label="Empty the whole cart">
              <button
                onClick={doClearCart}
                className="text-[11px] text-error hover:underline"
              >
                Clear All
              </button>
            </Tip>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-surface">
          {cart.length === 0 && (
            <p className="px-4 py-6 text-center text-body-sm text-on-surface-variant">
              {heldCart
                ? "Order held."
                : "Cart is empty. Scan a barcode to start."}
            </p>
          )}
          {cart.map((l) => {
            const packSize = products.find((p) => p.id === l.productId)?.pack_size ?? 1;
            const byPack = packSize > 1 && packStep[l.productId];
            const step = byPack ? packSize : 1;
            return (
            <div
              key={l.productId}
              className="group relative flex flex-col border-b border-outline-variant/30 p-2"
            >
              <div className="mb-1 flex items-start justify-between">
                <div className="pr-6">
                  <span className="font-data-mono text-data-mono font-bold leading-tight text-on-surface">
                    {l.name}
                  </span>
                  {l.unit && (
                    <span className="ml-1 text-[10px] text-on-surface-variant">{l.unit}</span>
                  )}
                </div>
                <span className="mr-8 font-data-mono text-data-mono text-on-surface">
                  {fmtMoney(l.unitPrice)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex items-center rounded border border-outline-variant bg-surface">
                  <Tip label="Fewer">
                    <button
                      onClick={() => setQty(l.productId, Math.max(1, l.qty - step))}
                      className="flex h-8 w-8 items-center justify-center rounded-l text-on-surface hover:bg-surface-variant"
                    >
                      <span className="material-symbols-outlined text-[16px]">remove</span>
                    </button>
                  </Tip>
                  <input
                    type="number"
                    min={1}
                    max={stockFor(l.productId)}
                    value={l.qty}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => {
                      const max = stockFor(l.productId);
                      const v = Number(e.target.value) || 1;
                      const clamped = max !== undefined ? Math.min(v, max) : v;
                      if (max !== undefined && v > max) {
                        useToast.getState().show(`Only ${max} in stock`, "error");
                      }
                      setQty(l.productId, clamped);
                    }}
                    className="h-8 w-10 border-x border-outline-variant/50 bg-transparent p-0 text-center font-data-mono text-data-mono focus:outline-none"
                  />
                  <Tip label="More">
                    <button
                      onClick={() => {
                        const max = stockFor(l.productId);
                        setQty(l.productId, max !== undefined ? Math.min(l.qty + step, max) : l.qty + step);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-r text-on-surface hover:bg-surface-variant"
                    >
                      <span className="material-symbols-outlined text-[16px]">add</span>
                    </button>
                  </Tip>
                </div>
                {packSize > 1 && (
                  <Tip label={byPack ? `+ / − steps a whole ${l.unit ?? "pack"} (${packSize})` : "+ / − steps one unit"}>
                    <button
                      onClick={() => setPackStep((m) => ({ ...m, [l.productId]: !m[l.productId] }))}
                      className={`flex h-6 items-center gap-0.5 rounded border px-1.5 text-[10px] font-bold transition-colors ${
                        byPack
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[12px]">inventory_2</span>
                      {byPack ? `×${packSize}` : "×1"}
                    </button>
                  </Tip>
                )}
                <span className="mr-8 ml-auto font-data-mono text-data-mono font-bold text-on-surface">
                  {fmtMoney(l.unitPrice * l.qty)}
                </span>
              </div>
              <button
                onClick={() => removeLine(l.productId)}
                title="Remove this line"
                aria-label={`Remove ${l.name}`}
                className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-error hover:bg-error-container hover:text-error"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            );
          })}
          <button
            onClick={() => setQuickAdd({ barcode: null })}
            className="flex w-full items-center justify-center gap-1 border-b border-dashed border-outline-variant/30 py-2 text-primary transition-colors hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span className="text-label-md font-label-md">Add Manual Item</span>
          </button>
          {heldCart && (
            <Tip label="Bring back the held order">
              <button
                onClick={restoreHeld}
                className="flex w-full items-center justify-center gap-1 py-2 text-primary transition-colors hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-[16px]">unarchive</span>
                <span className="text-label-md font-label-md">Restore Held Order</span>
              </button>
            </Tip>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-outline-variant bg-surface-container-low p-4">
          <div className="mb-2 space-y-1">
            <div className="flex justify-between font-data-mono text-body-sm text-on-surface-variant">
              <span>Subtotal</span>
              <span>{fmtMoney(subtotal)}</span>
            </div>
            {discountPct > 0 && (
              <div className="flex justify-between font-data-mono text-body-sm text-primary">
                <span>Discount ({discountPct}%)</span>
                <span>−{fmtMoney(discountAmt)}</span>
              </div>
            )}
            {taxRate > 0 && (
              <div className="flex justify-between font-data-mono text-body-sm text-on-surface-variant">
                <span>Tax ({taxRate}%)</span>
                <span>{fmtMoney(tax)}</span>
              </div>
            )}
            <div className="flex items-end justify-between border-t border-outline-variant pt-2">
              <span className="text-headline-md font-headline-md font-bold text-on-surface">
                Total
              </span>
              <span className="text-headline-lg font-headline-lg font-black text-primary">
                {fmtMoney(total)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {([
              { id: "Cash" as PaymentMethod, icon: "payments", label: "Cash", key: "F9" },
              { id: "Card" as PaymentMethod, icon: "credit_card", label: "Card", key: "F10" },
              { id: "MoMo" as PaymentMethod, icon: "send_to_mobile", label: "Mobile\nMoney", key: "F11" },
            ]).map((m) => {
              const active = selectedPay === m.id;
              return (
                <Tip key={m.id} label={`${m.label} (${m.key})`}>
                  <button
                    onClick={() => startCheckout(m.id)}
                    className={`flex w-full flex-col items-center gap-1 rounded py-2 shadow-sm transition-all active:scale-95 ${
                      active
                        ? "bg-primary text-on-primary border border-transparent"
                        : "border border-outline-variant bg-surface text-on-surface hover:border-outline hover:bg-surface-variant"
                    }`}
                  >
                    <span className={`material-symbols-outlined ${active ? "text-on-primary/80" : "text-outline"}`}>{m.icon}</span>
                    <span className="text-[11px] font-bold whitespace-pre-line text-center leading-tight">{m.label}</span>
                    <span className={`mt-1 rounded px-1 text-[9px] ${
                      active ? "bg-black/20 opacity-80" : "border border-outline-variant/50 bg-surface-container opacity-70"
                    }`}>{m.key}</span>
                  </button>
                </Tip>
              );
            })}
          </div>            <Tip label={lastMethod ? `Opens ${lastMethod} checkout (F9/F10/F11 to switch)` : "Opens Cash checkout (F9/F10/F11 to switch)"}>
              <button
                onClick={() => startCheckout(lastMethod ?? "Cash")}
                disabled={cart.length === 0}
                className="w-full rounded bg-primary py-2.5 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-40"
              >
                <span className="text-headline-md font-headline-md">
                  Complete Sale {cart.length > 0 ? `— ${fmtMoney(total)}` : ""}
                </span>
              </button>
            </Tip>

          <div className="mt-1 flex gap-2">
            <Tip label="Save this order — restore it later (F8)">
              <button
                onClick={() => {
                  if (useStore.getState().cart.length === 0) return;
                  holdOrder();
                  useToast.getState().show("Order held", "info");
                }}
                className="flex w-full items-center justify-center gap-1 rounded border border-outline-variant py-1.5 text-[11px] text-on-surface-variant transition-colors hover:bg-surface"
              >
                <span className="material-symbols-outlined text-[14px]">pause_circle</span>
                Hold Order
                <span className="ml-1 rounded border border-outline-variant/50 bg-surface-container px-1 text-[9px] opacity-70">
                  F8
                </span>
              </button>
            </Tip>
          </div>
        </div>
      </section>

      {payMethod && cart.length > 0 && (
        <PaymentModal
          total={total}
          lines={cart}
          discountPct={discountPct}
          initialMethod={payMethod}
          onClose={() => setPayMethod(null)}
          onComplete={(r, payments) => void onSaleComplete(r, payments)}
        />
      )}
      {lastSale && (
        <ReceiptModal
          result={lastSale.result}
          lines={lastSale.lines}
          subtotal={lastSale.subtotal}
          discountPct={lastSale.discountPct}
          discountAmt={lastSale.discountAmt}
          tax={lastSale.tax}
          paymentMethod={lastSale.method}
          payments={lastSale.payments}
          onClose={() => setLastSale(null)}
        />
      )}

      {showAddCustomer && <AddCustomerModal onClose={() => setShowAddCustomer(false)} />}

      {reorder && (
        <div data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div
            ref={reorderDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reorder-dialog-title"
            className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-5 shadow-lg"
          >
            <h3 id="reorder-dialog-title" className="mb-1 text-headline-md font-headline-md text-on-surface">
              Order {reorder.name}
            </h3>
            <p className="mb-4 text-body-sm font-body-sm text-on-surface-variant">
              Stock: {reorder.stock_qty} {reorder.unit ? `(${reorder.unit})` : ""} — this adds a
              requisition; receive the goods under Requisitions.
            </p>
            <label className="mb-1 block text-label-md font-label-md text-on-surface">
              Quantity to order
            </label>
            <input
              autoFocus
              type="number"
              min={1}
              value={orderQty}
              onChange={(e) => setOrderQty(Math.max(1, Number(e.target.value) || 1))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !orderBusy) void doReorder();
              }}
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {orderErr && <p className="mt-2 text-body-sm font-body-sm text-error">{orderErr}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setReorder(null)}
                className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Cancel
              </button>
              <button
                onClick={() => void doReorder()}
                disabled={orderBusy}
                className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
              >
                {orderBusy ? "Creating…" : "Add to Requisition"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
