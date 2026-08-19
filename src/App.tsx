import { useEffect, useState } from "react";
import { initDb, getSettings } from "./db";
import { useStore } from "./store/useStore";
import { initScanner } from "./lib/scanner";
import { beep } from "./lib/audio";
import { activeOperatorAt } from "./lib/shift";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QuickAddModal } from "./components/QuickAddModal";
import { IntakeModal } from "./components/IntakeModal";
import { PosPage } from "./pages/PosPage";
import { InventoryPage } from "./pages/InventoryPage";
import { RestockPage } from "./pages/RestockPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SupportPage } from "./pages/SupportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { ToastContainer } from "./components/ToastContainer";
import { useToast } from "./store/toast";

export default function App() {
  const page = useStore((s) => s.page);
  const [updating, setUpdating] = useState<{
    version: string;
    pct: number | null;
    note: string;
  } | null>(null);

  // Auto-update: installed builds check for a newer release on launch, download
  // it (with a small progress overlay), install, and restart. The dev app never
  // checks — you don't want the dev server pulling a release build.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    void (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        setUpdating({ version: update.version, pct: 0, note: "Downloading…" });
        await update.downloadAndInstall((event) => {
          if (cancelled) return;
          if (event.event === "Progress") {
            const progress = (event.data as { progress?: number }).progress;
            setUpdating((u) =>
              u ? { ...u, pct: Math.round((progress ?? 0) * 100) } : u,
            );
          } else if (event.event === "Finished") {
            setUpdating((u) => (u ? { ...u, pct: 100, note: "Installing…" } : u));
          }
        });
        await relaunch();
      } catch (e) {
        // No release yet, offline, or install hiccup — never block the app.
        console.error("auto-update:", e);
        setUpdating(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        await initDb();
        const s = await getSettings();
        if (disposed) return;
        useStore.getState().applySettings(s);
        await useStore.getState().refreshProducts();
        await useStore.getState().loadOperators();
        initScanner((code) => {
          const st = useStore.getState();
          const toast = useToast.getState();
          const p = st.products.find((x) => x.barcode === code);
          if (p) {
            if (p.stock_qty <= 0) {
              beep(false);
              toast.show(`${p.name} is out of stock`, "error");
              return;
            }
            st.addToCart(p);
            beep(true);
            toast.show(`${p.name} added`, "success", { duration: 1500 });
          } else {
            beep(false);
            toast.show(`Unknown barcode ${code} — quick add`, "info");
            st.setQuickAdd({ barcode: code });
          }
        });
      } catch (e) {
        console.error("init failed", e);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.key === "F2") {
        e.preventDefault();
        st.setIntakeOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Optional shift auto-switch: when enabled, keep the operator matching the
  // current time. Re-evaluates immediately when the toggle or the operator
  // list changes, then every 30s. Handles overnight shifts.
  const isDark = useStore((s) => s.isDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  const autoOperator = useStore((s) => s.autoOperator);
  const operators = useStore((s) => s.operators);
  useEffect(() => {
    const tick = () => {
      const st = useStore.getState();
      if (!st.autoOperator) return;
      const active = activeOperatorAt(st.operators);
      if (active && active.name !== st.operator) {
        st.setOperator(active.name);
      }
    };
    tick();
    const t = window.setInterval(tick, 30_000);
    return () => window.clearInterval(t);
  }, [autoOperator, operators]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-background font-body-md text-body-md antialiased">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col pl-64">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-hidden pt-14">
          {page === "pos" && <PosPage />}
          {page === "inventory" && <InventoryPage />}
          {page === "restock" && <RestockPage />}
          {page === "analytics" && <AnalyticsPage />}
          {page === "support" && <SupportPage />}
          {page === "expenses" && <ExpensesPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
      <QuickAddModal />
      <IntakeModal />
      <ToastContainer />

      {updating && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-5 shadow-lg">
            <h3 className="flex items-center gap-2 text-headline-md font-headline-md text-on-surface">
              <span className="material-symbols-outlined text-[20px]">system_update</span>
              Updating Pulse to v{updating.version}
            </h3>
            <p className="mt-1 text-body-sm font-body-sm text-on-surface-variant">
              {updating.note}
              {updating.pct !== null ? ` ${updating.pct}%` : ""} — the app will restart
              automatically.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-variant">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${updating.pct ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
