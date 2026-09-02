import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { initDb, loadPurchases } from "../db";
import type { Purchase } from "../db";
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
  const flash = useStore((s) => s.flash);
  const setSearch = useStore((s) => s.setSearch);
  const pharmacyName = useStore((s) => s.pharmacyName);
  const products = useStore((s) => s.products);
  const currentUser = useStore((s) => s.currentUser);
  const isWorker = currentUser?.role === "worker";

  const [notifOpen, setNotifOpen] = useState(false);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [searchText, setSearchText] = useState("");
  const [matches, setMatches] = useState<{ products: Product[]; patients: PatientHit[] }>({
    products: [],
    patients: [],
  });
  const [patientModal, setPatientModal] = useState<PatientHit | null>(null);
  const [highlight, setHighlight] = useState(-1);

  // Live product + patient matches as the user types.
  useEffect(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) {
      setMatches({ products: [], patients: [] });
      setHighlight(-1);
      return;
    }
    setHighlight(-1);
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
    setHighlight(-1);
  };

  // Build a flat list of all searchable hits for arrow navigation.
  const allHits = useMemo(() => {
    const items: { kind: "product" | "patient"; data: Product | PatientHit }[] = [];
    matches.products.forEach((p) => items.push({ kind: "product", data: p }));
    matches.patients.forEach((p) => items.push({ kind: "patient", data: p }));
    return items;
  }, [matches]);

  const onEnter = () => {
    if (highlight >= 0 && highlight < allHits.length) {
      const hit = allHits[highlight];
      if (hit.kind === "product") {
        goToPosSearch((hit.data as Product).name);
      } else {
        setSearchText("");
        setMatches({ products: [], patients: [] });
        setHighlight(-1);
        setPatientModal(hit.data as PatientHit);
      }
      return;
    }
    const q = searchText.trim();
    if (!q) return;
    const exact = matches.patients.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (exact) {
      setSearchText("");
      setMatches({ products: [], patients: [] });
      setHighlight(-1);
      setPatientModal(exact);
    } else {
      goToPosSearch(q);
    }
  };

  const refreshPurchases = () => {
    loadPurchases()
      .then(setPurchases)
      .catch(() => {});
  };
  useEffect(() => {
    refreshPurchases();
  }, []);

  const today = fmt(new Date());
  const in60 = fmt(new Date(Date.now() + 60 * 864e5));

  // "Mark all as read": alerts are DERIVED from live data (stock, expiry,
  // purchase status), so there is no read-flag column anywhere. Instead we
  // keep a persisted set of dismissed alert KEYS — each alert gets a stable
  // identity (product + type + expiry where relevant) so dismissing hides it
  // but genuinely NEW problems still raise the badge.
  const [dismissed, setDismissed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("pulse.alerts.dismissed") ?? "{}");
    } catch {
      return {};
    }
  });
  const persistDismissed = (d: Record<string, boolean>) => {
    setDismissed(d);
    try {
      localStorage.setItem("pulse.alerts.dismissed", JSON.stringify(d));
    } catch {
      /* storage full/blocked — dismissal just won't survive restart */
    }
  };

  const rawLow = products.filter((p) => p.stock_qty <= p.reorder_level);
  const rawExpiring = products.filter(
    (p) => p.expiry_date && p.expiry_date > today && p.expiry_date <= in60,
  );
  // Inclusive of today, matching lib/stock.ts's stockStatus() and the
  // Reports page's stock-health widgets — a product expiring exactly today
  // must count as expired everywhere, not just on the pages checked first.
  const rawExpired = products.filter((p) => p.expiry_date && p.expiry_date <= today);
  const rawOpenPurchases = purchases.filter(
    (p) => p.status === "Ordered" || p.status === "Draft",
  );

  const lowKey = (id: number | string) => `low:${id}`;
  const expKey = (id: number | string, d?: string | null) => `exp:${id}:${d}`;
  const poKey = (id: number | string) => `po:${id}`;

  const low = rawLow.filter((p) => !dismissed[lowKey(p.id)]);
  const expiring = rawExpiring.filter((p) => !dismissed[expKey(p.id, p.expiry_date)]);
  const expired = rawExpired.filter((p) => !dismissed[expKey(p.id, p.expiry_date)]);
  const openPurchases = rawOpenPurchases.filter((p) => !dismissed[poKey(p.id)]);

  const markAllRead = () => {
    const next: Record<string, boolean> = { ...dismissed };
    rawLow.forEach((p) => (next[lowKey(p.id)] = true));
    rawExpiring.forEach((p) => (next[expKey(p.id, p.expiry_date)] = true));
    rawExpired.forEach((p) => (next[expKey(p.id, p.expiry_date)] = true));
    if (!isWorker) rawOpenPurchases.forEach((p) => (next[poKey(p.id)] = true));
    persistDismissed(next);
  };

  const alertCount = low.length + expiring.length + expired.length + (isWorker ? 0 : openPurchases.length);
  const tipLabel = alertCount > 0 ? `${alertCount} alert${alertCount === 1 ? "" : "s"} — tap to view` : "No alerts — all good";

  const Section = ({
    title,
    items,
    to,
  }: {
    title: string;
    items: { name: string; hint: string; id: number | string; kind: "product" | "purchase" }[];
    to: "inventory" | "restock";
  }) =>
    items.length === 0 ? null : (
      <div className="border-b border-outline-variant/50 px-3 py-2 last:border-0">
        <p className="mb-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
          {title} ({items.length})
        </p>
        {items.slice(0, 4).map((it) => (
          <button
            key={it.id}
            onClick={() => {
              flash(it.kind, it.id);
              setPage(to);
              setNotifOpen(false);
            }}
            className="flex w-full items-center justify-between gap-3 rounded py-0.5 text-left text-body-sm text-on-surface hover:bg-surface-container-low"
          >
            <span className="truncate">{it.name}</span>
            <span className="shrink-0 text-on-surface-variant">{it.hint}</span>
          </button>
        ))}
        {items.length > 4 && (
          <p className="text-[11px] text-on-surface-variant">+{items.length - 4} more</p>
        )}
      </div>
    );

  return (
    <header className="fixed right-0 top-0 z-20 flex h-14 w-[calc(100%-16rem)] items-center justify-between border-b border-outline-variant bg-surface px-margin-page">
      <div className="flex items-center gap-6">
        <h1 className="text-headline-md font-headline-md font-black tracking-tight text-primary">
          {pharmacyName}
        </h1>
      </div>

      <div className="relative mx-8 hidden min-w-[16rem] max-w-md flex-1 md:block">
        <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-outline">
          search
        </span>
        <input
          id="global-search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onEnter(); }
            else if (e.key === "Escape") {
              setSearchText("");
              setMatches({ products: [], patients: [] });
              setHighlight(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h < allHits.length - 1 ? h + 1 : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h > 0 ? h - 1 : allHits.length - 1));
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
        </div>            {searchText.trim() && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSearchText("")} />
            <div className="absolute left-0 right-0 top-10 z-50 overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
              <button
                onClick={() => {
                  setSearchText("");
                  setMatches({ products: [], patients: [] });
                  setHighlight(-1);
                  setPage("customers");
                  setNotifOpen(false);
                }}
                className="flex w-full items-center gap-2 border-b border-outline-variant/50 px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-[18px] text-primary">groups</span>
                <span className="min-w-0 truncate">Manage customers</span>
                <span className="ml-auto shrink-0 text-[11px] text-on-surface-variant">Go to Customers</span>
              </button>
              {matches.products.length > 0 && (
                <div className="border-b border-outline-variant/50 px-3 py-1 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                  Products
                </div>
              )}
              {matches.products.map((p, i) => (
                <button
                  key={`p${p.id}`}
                  onClick={() => goToPosSearch(p.name)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors ${
                    highlight === i ? "bg-primary/10 text-primary" : "hover:bg-surface-container-low"
                  }`}
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
              {matches.patients.map((pt, i) => {
                const idx = matches.products.length + i;
                return (
                  <button
                    key={`pt${pt.name}`}
                    onClick={() => {
                      setSearchText("");
                      setMatches({ products: [], patients: [] });
                      setHighlight(-1);
                      setPatientModal(pt);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors ${
                      highlight === idx ? "bg-primary/10 text-primary" : "hover:bg-surface-container-low"
                    }`}
                  >
                    <span className="min-w-0 truncate text-body-sm text-on-surface">{pt.name}</span>
                    <span className="ml-2 shrink-0 font-data-mono text-data-mono text-on-surface-variant">
                      {pt.phone ?? "—"}
                    </span>
                  </button>
                );
              })}
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
                refreshPurchases();
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
                <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-3 py-2">
                  <span className="text-headline-md font-headline-md text-on-surface">Alerts</span>
                  {alertCount > 0 && (
                    <button
                      onClick={markAllRead}
                      className="text-label-md font-label-md text-primary hover:underline"
                    >
                      Mark all as read
                    </button>
                  )}
                </div>
                <div className="max-h-[70vh] overflow-y-auto overscroll-contain">
                  <Section
                    title="Low stock"
                    items={low.map((p) => ({ name: p.name, hint: `${p.stock_qty} left`, id: p.id, kind: "product" as const }))}
                    to="inventory"
                  />
                  <Section
                    title="Expiring soon"
                    items={expiring.map((p) => ({ name: p.name, hint: p.expiry_date ?? "", id: p.id, kind: "product" as const }))}
                    to="inventory"
                  />
                  <Section
                    title="Expired"
                    items={expired.map((p) => ({ name: p.name, hint: p.expiry_date ?? "", id: p.id, kind: "product" as const }))}
                    to="inventory"
                  />
                  {!isWorker && (
                    <Section
                      title="Open purchases"
                      items={openPurchases.map((p) => ({
                        name: p.reference_no ?? p.id,
                        hint: p.supplier_name ?? "no supplier",
                        id: p.id,
                        kind: "purchase" as const,
                      }))}
                      to="restock"
                    />
                  )}
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
