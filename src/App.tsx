import { useEffect, useRef, useState } from "react";
import { initDb, getSettings, isManagerPinSet } from "./db";
import { useStore } from "./store/useStore";
import { initScanner } from "./lib/scanner";
import { beep } from "./lib/audio";
import { activeOperatorAt } from "./lib/shift";
import { checkForUpdate } from "./lib/updater";
import { UpdateBanner } from "./components/UpdateBanner";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QuickAddModal } from "./components/QuickAddModal";
import { IntakeModal } from "./components/IntakeModal";
import { SetupWizard } from "./components/SetupWizard";
import { ProductTour } from "./components/ProductTour";
import { LoginPage } from "./components/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PosPage } from "./pages/PosPage";
import { InventoryPage } from "./pages/InventoryPage";
import { RestockPage } from "./pages/RestockPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { CustomersPage } from "./pages/CustomersPage";
import { SupportPage } from "./pages/SupportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { ToastContainer } from "./components/ToastContainer";
import { useToast } from "./store/toast";

export default function App() {
  const page = useStore((s) => s.page);
  /** Startup failure that survived every retry — shown with a Retry button
   * instead of leaving the app silently empty (all-defaults UI). */
  const [initError, setInitError] = useState("");
  /** Splash screen: shown from first paint until the DB, settings and
   * products have loaded (or init failed). */
  const [ready, setReady] = useState(false);
  const scannerReady = useRef(false);

  // Barcode scanning: started exactly once per session, by whichever init
  // path succeeds first (boot, splash retry, or banner retry). Keeping this
  // in ONE shared place is what stops retry paths from silently dropping it.
  const startScannerOnce = () => {
    if (scannerReady.current) return;
    scannerReady.current = true;
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
        // Same at-cart-max guard as PosPage's tryAdd — addToCart silently
        // no-ops once the cart hits stock_qty, so without this a repeat
        // scan past available stock would still play a success beep.
        const line = st.cart.find((l) => l.productId === p.id);
        if (line && line.qty >= p.stock_qty) {
          beep(false);
          toast.show(`Max stock reached for ${p.name}`, "error");
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
  };

  // THE startup sequence — db, settings, products, operators, role gate,
  // scanner. Every entry point (clean launch and every retry) runs exactly
  // this so none of them can drift. Resolves true on success.
  const runStartupInit = async (): Promise<boolean> => {
    await initDb();
    const s = await getSettings();
    useStore.getState().applySettings(s);
    await useStore.getState().refreshProducts();
    await useStore.getState().loadOperators();
  // Role gate: a configured manager PIN means every entry point starts at
  // counter privilege, retries included. Fail closed if the check itself errors.
  const pinSet = await isManagerPinSet().catch(() => true);
  useStore.getState().setRole(pinSet ? "mca" : "manager");
    startScannerOnce();
    return true;
  };

  // Auto-update: installed builds check for a newer release on launch and
  // raise a banner — the worker picks the moment, nothing downloads or
  // restarts mid-shift uninvited. The dev app never checks. A failed check
  // retries every 15 minutes and when the network comes back, so one bad
  // launch (offline, unpublished release) doesn't silence updates all day.
  // A dismissed banner ("Later") stays dismissed until next launch.
  const availableUpdate = useStore((s) => s.availableUpdate);
  const setAvailableUpdate = useStore((s) => s.setAvailableUpdate);
  const [updateNotif, setUpdateNotif] = useState(true);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    // Settles only when an update is found — a quiet "nothing yet" keeps the
    // 15-minute retry alive, so a release published mid-shift still raises
    // the banner without a relaunch. Retries never toast.
    let settled = false;
    const runCheck = async (quiet: boolean) => {
      if (cancelled || settled) return;
      try {
        const found = await checkForUpdate();
        if (cancelled) return;
        if (found) {
          setAvailableUpdate(found);
          settled = true;
        }
      } catch (e) {
        // Offline, no published release yet, bad manifest — never block the app.
        console.error("auto-update:", e);
        if (!quiet && !cancelled) {
          try {
            const { useToast } = await import("./store/toast");
            useToast.getState().show(String(e instanceof Error ? e.message : e), "error");
          } catch {
            /* toast store not ready — ignore */
          }
        }
      }
    };
    void runCheck(false);
    const retry = window.setInterval(() => {
      if (!document.hidden) void runCheck(true);
    }, 15 * 60 * 1000);
    const onOnline = () => void runCheck(true);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.clearInterval(retry);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const attempt = async (): Promise<boolean> => {
      try {
        await runStartupInit();
        if (disposed) return true;
        setReady(true);
        setInitError("");
        return true;
      } catch (e) {
        console.error("init failed", e);
        if (!disposed) {
          setInitError(String(e).replace(/^Error: /, ""));
        }
        return false;
      }
    };

    // Retries with backoff: during `tauri dev` restarts the freshly spawned
    // instance can race the old one for the SQLite file (database is locked)
    // and lose — that must cost a retry, not an empty app with no explanation.
    void (async () => {
      const delays = [0, 1500, 4000];
      for (const d of delays) {
        if (d) await new Promise((r) => setTimeout(r, d));
        if (disposed) return;
        if (await attempt()) return;
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never fire while a modal owns the screen (payment, PIN prompt, …) —
      // F2 opening Intake mid-checkout is a mis-key, not an intent.
      if (document.querySelector("[data-modal-open]")) return;
      const st = useStore.getState();
      if (e.key === "F2") {
        e.preventDefault();
        // Receive-stock is manager-only — MCAs must not open intake.
        if (st.currentUser?.role === "mca") return;
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

  // FDA catalog refresh progress: subscribed once here (App never unmounts),
  // so switching tabs mid-update can't lose the progress bar or the result.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{
        current: number;
        total: number;
        page: number;
        totalPages: number;
      }>("fda-progress", (e) => useStore.getState().setFdaProgress(e.payload)).then(
        (fn) => (unlisten = fn),
      ),
    );
    return () => {
      unlisten?.();
    };
  }, []);

  // WebKitGTK quirk: the native date-picker calendar on <input type="date">
  // only closes via Esc or picking a day — an outside click leaves it open.
  // Blur the focused date input on any click elsewhere; the popup follows
  // focus. (Popup-internal clicks happen in a separate native surface and
  // never reach this handler, so picking a date still works.)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === "date" && e.target !== el) {
        el.blur();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  // Optional shift auto-switch: when enabled, keep the operator matching the
  // Theme: managers/owners use the manual toggle; logged-out screens follow
  // time (6am-6pm light, otherwise dark). MCAs get the manual toggle too
  // (their Settings is theme-only), so auto applies only before login.
  const isDark = useStore((s) => s.isDark);
  const currentUserEarly = useStore((s) => s.currentUser);
  const shouldAuto = !currentUserEarly;
  const [autoDark, setAutoDark] = useState(() => {
    const h = new Date().getHours();
    return h < 6 || h >= 18;
  });
  useEffect(() => {
    if (!shouldAuto) return;
    const tick = () => {
      const h = new Date().getHours();
      setAutoDark(h < 6 || h >= 18);
    };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => window.clearInterval(t);
  }, [shouldAuto]);
  const effectiveDark = shouldAuto ? autoDark : isDark;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveDark);
  }, [effectiveDark]);

  const autoOperator = useStore((s) => s.autoOperator);
  const operators = useStore((s) => s.operators);
  const setupComplete = useStore((s) => s.setupComplete);
  const tourSeen = useStore((s) => s.tourSeen);
  const tourOpen = useStore((s) => s.tourOpen);
  const currentUser = useStore((s) => s.currentUser);
  const isMca = currentUser?.role === "mca";
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

  // MCAs are hidden from Requisitions (ordering/receiving/paying) — bounce
  // them to dashboard. Reports and Settings render in scoped form instead
  // (own-data reports, theme-only settings), so they stay mounted.
  useEffect(() => {
    if (!currentUser || currentUser.role !== "mca") return;
    if (["restock"].includes(page)) {
      useStore.getState().setPage("dashboard");
    }
  }, [page, currentUser]);

  // Auth gate: setup wizard first, then login.
  if (!currentUser) {
    if (!setupComplete && ready) {
      return (
        <div className="flex h-screen overflow-hidden bg-background text-on-background font-body-md antialiased">
          <SetupWizard onDone={() => {}} />
          <ToastContainer />
        </div>
      );
    }
    if (ready && setupComplete) {
      return (
        <div className="flex h-screen overflow-hidden bg-background text-on-background font-body-md antialiased">
          <LoginPage />
          <ToastContainer />
        </div>
      );
    }
  }

  // Splash: covers the shell until init completes. Branded, quiet, no
  // spinner theatre — just the mark and the pharmacy's name.
  if (!ready) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-on-background font-body-md antialiased">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded bg-primary text-headline-lg font-bold text-on-primary">
            P
          </div>
          <div>
            <p className="text-headline-lg font-headline-lg leading-none tracking-tight text-on-surface">
              Pulse
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-on-surface-variant">
              Pharmacy MS
            </p>
          </div>
        </div>
        {initError ? (
          <div className="mt-4 flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-body-sm font-body-sm text-error">Startup problem: {initError}</p>
            <button
              onClick={() => {
                setInitError("");
                void runStartupInit()
                  .then(() => setReady(true))
                  .catch((e) => setInitError(String(e).replace(/^Error: /, "")));
              }}
              className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary hover:bg-on-primary-fixed-variant"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-body-sm font-body-sm text-on-surface-variant">Opening…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-background font-body-md text-body-md antialiased">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col pl-64">
        {initError && (
          <div className="flex items-center gap-3 border-b border-error/30 bg-error-container px-4 py-2 text-on-error-container">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span className="min-w-0 flex-1 truncate text-body-sm font-body-sm" title={initError}>
              Startup problem: {initError}
            </span>
            <button
              onClick={() => {
                setInitError("");
                void runStartupInit().catch((e) =>
                  setInitError(String(e).replace(/^Error: /, "")),
                );
              }}
              className="shrink-0 rounded border border-on-error-container/40 px-2 py-1 text-label-md font-label-md hover:bg-black/5"
            >
              Retry
            </button>
          </div>
        )}
        <TopBar />
        {availableUpdate && updateNotif && (
          <UpdateBanner update={availableUpdate} onDone={() => setUpdateNotif(false)} />
        )}
        <main className="min-h-0 flex-1 overflow-hidden pt-14">
          {page === "dashboard" && <DashboardPage />}
          {page === "pos" && <PosPage />}
          {page === "inventory" && <InventoryPage />}
          {page === "history" && <HistoryPage />}
          {page === "customers" && <CustomersPage />}
          {page === "support" && <SupportPage />}
          {page === "expenses" && <ExpensesPage />}
          {!isMca && page === "restock" && <RestockPage />}
          {page === "analytics" && <AnalyticsPage />}
          {page === "settings" && <SettingsPage />}
          {isMca && page === "restock" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <span className="material-symbols-outlined text-[40px] text-on-surface-variant">lock</span>
              <p className="text-headline-md font-headline-md text-on-surface">Manager required</p>
              <p className="max-w-sm text-body-sm font-body-sm text-on-surface-variant">Ordering and receiving are hidden for your role.</p>
            </div>
          )}
        </main>
      </div>
      <QuickAddModal />
      <IntakeModal />
      <ToastContainer />

      {!setupComplete && <SetupWizard onDone={() => {}} />}

      {setupComplete && (!tourSeen || tourOpen) && <ProductTour />}
    </div>
  );
}
