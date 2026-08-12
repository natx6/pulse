import { useEffect } from "react";
import { initDb, getSettings } from "./db";
import { useStore } from "./store/useStore";
import { initScanner } from "./lib/scanner";
import { beep } from "./lib/audio";
import { activeOperatorAt } from "./lib/shift";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QuickAddModal } from "./components/QuickAddModal";
import { IntakeModal } from "./components/IntakeModal";
import { PosPage } from "./pages/PosPage";
import { InventoryPage } from "./pages/InventoryPage";
import { RestockPage } from "./pages/RestockPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  const page = useStore((s) => s.page);

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
          const p = st.products.find((x) => x.barcode === code);
          if (p) {
            if (p.stock_qty <= 0) {
              beep(false);
              return;
            }
            st.addToCart(p);
            beep(true);
          } else {
            beep(false);
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Optional shift auto-switch: when enabled, keep the operator matching the
  // current time. Re-evaluates immediately when the toggle or the operator
  // list changes, then every 30s. Handles overnight shifts.
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
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
      <QuickAddModal />
      <IntakeModal />
    </div>
  );
}
