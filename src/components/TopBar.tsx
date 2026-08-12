import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { initDb, loadPurchaseOrders } from "../db";
import type { PurchaseOrder } from "../db";
import type { Product } from "../types";
import { Tip } from "./Tip";
import { PatientModal } from "./PatientModal";

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface PatientHit {
  name: string;
  phone: string | null;
}

export function TopBar() {
  const newSale = useStore((s) => s.newSale);
  const setPage = useStore((s) => s.setPage);
  const setSearch = useStore((s) => s.setSearch);
  const pharmacyName = useStore((s) => s.pharmacyName);
  const products = useStore((s) => s.products);

  const [notifOpen, setNotifOpen] = useState(false);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [searchText, setSearchText] = useState("");
  const [matches, setMatches] = useState<{ products: Product[]; patients: PatientHit[] }>({
    products: [],
    patients: [],
  });
  const [patientModal, setPatientModal] = useState<PatientHit | null>(null);

  // Live product + patient matches as the user types.
  useEffect(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) {
      setMatches({ products: [], patients: [] });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = await initDb();
        const patients = await db.select<PatientHit[]>(
          "SELECT name, phone FROM patients WHERE name LIKE $1 OR phone LIKE $1 ORDER BY name LIMIT 5",
          [`%${q}%`],
        );
        if (cancelled) return;
        setMatches({
          products: products
            .filter(
              (p) => p.name.toLowerCase().includes(q) || (p.barcode ?? "").includes(q),
            )
            .slice(0, 5),
          patients: patients.map((p) => ({ name: p.name, phone: p.phone ?? null })),
        });
      } catch {
        if (!cancelled) setMatches({ products: [], patients: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchText, products]);

  const goToPosSearch = (q: string) => {
    setSearch(q);
    setPage("pos");
    setSearchText("");
    setMatches({ products: [], patients: [] });
  };

  const onEnter = () => {
    const q = searchText.trim();
    if (!q) return;
    const exact = matches.patients.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (exact) {
      setSearchText("");
      setMatches({ products: [], patients: [] });
      setPatientModal(exact);
    } else {
      goToPosSearch(q);
    }
  };

  const refreshPos = () => {
    loadPurchaseOrders()
      .then(setPos)
      .catch(() => {});
  };
  useEffect(() => {
    refreshPos();
  }, []);

  const today = fmt(new Date());
  const in60 = fmt(new Date(Date.now() + 60 * 864e5));

  const low = products.filter((p) => p.stock_qty <= p.reorder_level);
  const expiring = products.filter(
    (p) => p.expiry_date && p.expiry_date > today && p.expiry_date <= in60,
  );
  const expired = products.filter((p) => p.expiry_date && p.expiry_date < today);
  const openPos = pos.filter((po) => po.status === "open");

  const alertCount = low.length + expiring.length + expired.length + openPos.length;
  const tipLabel = alertCount > 0 ? `${alertCount} alert${alertCount === 1 ? "" : "s"} — tap to view` : "No alerts — all good";

  const Section = ({
    title,
    items,
    to,
    hint,
  }: {
    title: string;
    items: { name: string; hint: string }[];
    to: "inventory" | "restock";
    hint: string;
  }) =>
    items.length === 0 ? null : (
      <div className="border-b border-outline-variant/50 px-3 py-2 last:border-0">
        <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
          {title} ({items.length})
        </p>
        {items.slice(0, 4).map((it) => (
          <p key={it.name} className="flex justify-between gap-3 py-0.5 text-body-sm text-on-surface">
            <span className="truncate">{it.name}</span>
            <span className="shrink-0 text-on-surface-variant">{it.hint}</span>
          </p>
        ))}
        {items.length > 4 && (
          <p className="text-[11px] text-on-surface-variant">+{items.length - 4} more</p>
        )}
        <button
          onClick={() => {
            setPage(to);
            setNotifOpen(false);
          }}
          className="mt-1 text-label-md font-label-md text-primary hover:underline"
        >
          {hint}
        </button>
      </div>
    );

  return (
    <header className="fixed right-0 top-0 z-20 flex h-14 w-[calc(100%-16rem)] items-center justify-between border-b border-outline-variant bg-surface px-margin-page">
      <div className="flex items-center gap-6">
        <h1 className="text-headline-md font-headline-md font-black tracking-tight text-primary">
          {pharmacyName}
        </h1>
      </div>

      <div className="relative mx-8 hidden max-w-md flex-1 lg:block">
        <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-outline">
          search
        </span>
        <input
          id="global-search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
            if (e.key === "Escape") {
              setSearchText("");
              setMatches({ products: [], patients: [] });
            }
          }}
          placeholder="Search products, patients..."
          className="h-8 w-full rounded border border-outline-variant bg-surface-container-low pl-8 pr-14 text-body-sm placeholder-outline focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-60">
          <span className="rounded border border-outline-variant bg-surface px-1 text-shortcut-hint font-shortcut-hint text-on-surface-variant">
            Ctrl
          </span>
          <span className="rounded border border-outline-variant bg-surface px-1 text-shortcut-hint font-shortcut-hint text-on-surface-variant">
            K
          </span>
        </div>

        {searchText.trim() && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSearchText("")} />
            <div className="absolute left-0 right-0 top-10 z-50 overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
              {matches.products.length > 0 && (
                <div className="border-b border-outline-variant/50 px-3 py-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                  Products
                </div>
              )}
              {matches.products.map((p) => (
                <button
                  key={`p${p.id}`}
                  onClick={() => goToPosSearch(p.name)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-surface-container-low"
                >
                  <span className="min-w-0 truncate text-body-sm text-on-surface">{p.name}</span>
                  <span className="ml-2 shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                    {p.barcode ?? "—"}
                  </span>
                </button>
              ))}
              {matches.patients.length > 0 && (
                <div className="border-b border-outline-variant/50 px-3 py-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                  Patients
                </div>
              )}
              {matches.patients.map((pt) => (
                <button
                  key={`pt${pt.name}`}
                  onClick={() => {
                    setSearchText("");
                    setMatches({ products: [], patients: [] });
                    setPatientModal(pt);
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-surface-container-low"
                >
                  <span className="min-w-0 truncate text-body-sm text-on-surface">{pt.name}</span>
                  <span className="ml-2 shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                    {pt.phone ?? "—"}
                  </span>
                </button>
              ))}
              {matches.products.length === 0 && matches.patients.length === 0 && (
                <p className="px-3 py-3 text-body-sm text-on-surface-variant">
                  No matches — Enter searches the counter.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        <Tip label="Fresh sale — holds the current order and clears the counter" dir="bottom">
          <button
            onClick={newSale}
            className="flex h-8 items-center gap-2 rounded bg-primary px-4 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
          >
            <span className="material-symbols-outlined text-[18px]">add_circle</span>
            <span className="text-label-md font-label-md">New Prescription</span>
          </button>
        </Tip>
        <Tip label="Open the counter and focus the scanner" dir="bottom">
          <button
            onClick={() => {
              setPage("pos");
              document.getElementById("pos-search")?.focus();
            }}
            className="flex h-8 items-center gap-1 rounded border border-outline-variant px-3 text-on-surface transition-colors hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[18px]">barcode_scanner</span>
            <span className="text-label-md font-label-md">Barcode Scan</span>
          </button>
        </Tip>
        <div className="relative ml-2 border-l border-outline-variant pl-4">
          <Tip label={tipLabel} dir="bottom">
            <button
              onClick={() => {
                refreshPos();
                setNotifOpen((o) => !o);
              }}
              className="relative flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-low"
            >
              <span className="material-symbols-outlined">notifications</span>
              {alertCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-[10px] font-bold text-on-error">
                  {alertCount}
                </span>
              )}
            </button>
          </Tip>

          {notifOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
              <div className="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
                <div className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-headline-md font-headline-md text-on-surface">
                  Alerts
                </div>
                <div className="max-h-[22rem] overflow-y-auto">
                  <Section
                    title="Low stock"
                    items={low.map((p) => ({ name: p.name, hint: `${p.stock_qty} left` }))}
                    to="inventory"
                    hint="Go to Inventory"
                  />
                  <Section
                    title="Expiring soon"
                    items={expiring.map((p) => ({ name: p.name, hint: p.expiry_date ?? "" }))}
                    to="inventory"
                    hint="Go to Inventory"
                  />
                  <Section
                    title="Expired"
                    items={expired.map((p) => ({ name: p.name, hint: p.expiry_date ?? "" }))}
                    to="inventory"
                    hint="Go to Inventory"
                  />
                  <Section
                    title="Open requisitions"
                    items={openPos.map((po) => ({
                      name: po.po_no,
                      hint: po.supplier ?? "no supplier",
                    }))}
                    to="restock"
                    hint="Go to Requisitions"
                  />
                  {alertCount === 0 && (
                    <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant">
                      Nothing needs attention.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {patientModal && (
        <PatientModal
          name={patientModal.name}
          phone={patientModal.phone}
          onClose={() => setPatientModal(null)}
        />
      )}
    </header>
  );
}
