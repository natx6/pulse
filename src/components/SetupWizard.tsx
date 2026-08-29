import { useState } from "react";
import {
  saveSetting,
  setManagerPin,
  type AppSettings,
} from "../db";
import { useStore } from "../store/useStore";
import { ImportStockModal } from "../components/ImportStockModal";
import { ImportCustomersModal } from "../components/ImportCustomersModal";
import { ImportSuppliersModal } from "../components/ImportSuppliersModal";

type ImportKind = "stock" | "customers" | "suppliers" | null;

/** First-run setup wizard. Shown once, when the "setup_complete" setting is
 * not set, so a freshly installed pharmacy enters its own details, sets a
 * manager PIN, and optionally imports their existing data. Finishing persists
 * setup_complete so it never shows again. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const applySettings = useStore((s) => s.applySettings);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [tax, setTax] = useState("");
  const [footer, setFooter] = useState("");
  const [momo, setMomo] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [importKind, setImportKind] = useState<ImportKind>(null);

  const steps = ["Welcome", "Pharmacy", "Manager PIN", "Printer", "Your data", "Done"];

  const finish = async () => {
    setBusy(true);
    setErr("");
    try {
      await saveSetting("pharmacy_name", name.trim() || "Pulse Pharmacy");
      await saveSetting("tax_rate", tax.trim() || "0");
      await saveSetting("receipt_footer", footer.trim());
      await saveSetting("momo_number", momo.trim());
      await saveSetting("printer_host", host.trim());
      await saveSetting("printer_port", String(Math.max(1, Math.floor(Number(port)) || 9100)));
      if (pin.trim()) {
        await setManagerPin(null, pin.trim());
      }
      await saveSetting("setup_complete", "1");
      const next: Partial<AppSettings> = {
        pharmacyName: name.trim() || "Pulse Pharmacy",
        taxRate: Number(tax) || 0,
        receiptFooter: footer.trim(),
        momoNumber: momo.trim(),
        printerHost: host.trim(),
        printerPort: Math.max(1, Math.floor(Number(port)) || 9100),
        setupComplete: true,
      };
      applySettings(next);
      onDone();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      setBusy(false);
    }
  };

  const canNext =
    step === 0 ||
    step === 1 ||
    step === 2 ||
    step === 3 ||
    step === 4;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-on-background/40 p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant px-5 py-3">
          <h3 className="text-headline-md font-headline-md text-on-surface">Set up Pulse</h3>
          <span className="text-label-md font-label-md text-on-surface-variant">
            Step {Math.min(step + 1, steps.length)} / {steps.length}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {err && (
            <p className="mb-3 rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
              {err}
            </p>
          )}

          {step === 0 && (
            <div>
              <span className="material-symbols-outlined mb-2 text-[40px] text-primary">local_pharmacy</span>
              <p className="text-title-sm font-medium text-on-surface">Welcome to Pulse</p>
              <p className="mt-2 text-body-sm text-on-surface-variant">
                Let's get your pharmacy ready. This takes a minute: your shop details, a manager
                PIN to protect voids and refunds, and an optional import of your existing products,
                customers and suppliers. You can change anything later in Settings.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="grid grid-cols-1 gap-3">
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Pharmacy name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ama Pharmacy"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Tax rate %</span>
                  <input
                    value={tax}
                    onChange={(e) => setTax(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="0"
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">MoMo number</span>
                  <input
                    value={momo}
                    onChange={(e) => setMomo(e.target.value)}
                    placeholder="024…"
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Receipt footer</span>
                <input
                  value={footer}
                  onChange={(e) => setFooter(e.target.value)}
                  placeholder="Thank you · address · phone"
                  className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="mb-3 text-body-sm text-on-surface-variant">
                A manager PIN protects sensitive actions — voids, refunds, credit settlement,
                supplier payments and restores. You can skip this now and set it later in Settings,
                but we recommend adding one.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="4–8 digits"
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm tracking-[0.3em] text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Confirm PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="4–8 digits"
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm tracking-[0.3em] text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
              </div>
              {pin.trim() && pin.trim().length < 4 && (
                <p className="mt-2 text-body-sm text-error">PIN must be at least 4 digits.</p>
              )}
              {pin.trim() && pinConfirm.trim() && pin !== pinConfirm && (
                <p className="mt-2 text-body-sm text-error">PINs don't match.</p>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <p className="mb-3 text-body-sm text-on-surface-variant">
                Connect a thermal receipt printer (ESC/POS, port 9100). Optional — you can print
                later from Settings.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Printer IP</span>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100"
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-label-md font-label-md text-on-surface">Port</span>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
                    className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <p className="mb-3 text-body-sm text-on-surface-variant">
                Bring over your existing data from the old system — or start empty and add products
                as you go. Each importer matches columns automatically.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setImportKind("stock")}
                  className="flex items-center gap-2 rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-container-lowest"
                >
                  <span className="material-symbols-outlined text-[18px] text-primary">inventory_2</span>
                  Import products &amp; stock
                </button>
                <button
                  onClick={() => setImportKind("customers")}
                  className="flex items-center gap-2 rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-container-lowest"
                >
                  <span className="material-symbols-outlined text-[18px] text-primary">groups</span>
                  Import customers &amp; opening balances
                </button>
                <button
                  onClick={() => setImportKind("suppliers")}
                  className="flex items-center gap-2 rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-container-lowest"
                >
                  <span className="material-symbols-outlined text-[18px] text-primary">local_shipping</span>
                  Import suppliers &amp; what you owe
                </button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="text-center">
              <span className="material-symbols-outlined mb-2 text-[40px] text-success">check_circle</span>
              <p className="text-title-sm font-medium text-on-surface">You're all set</p>
              <p className="mt-2 text-body-sm text-on-surface-variant">
                Pulse is ready. Start a sale from the POS, or import more data any time from
                Inventory / Customers / Analytics.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-outline-variant bg-surface-container-lowest px-5 py-3">
          {step > 0 && step < 5 ? (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="rounded border border-outline-variant px-4 py-1.5 text-label-md font-label-md text-on-surface hover:bg-surface-container-low"
            >
              Back
            </button>
          ) : (
            <span />
          )}
          {step < 5 ? (
            <button
              onClick={() => {
                if (step === 2 && pin.trim() && (pin.length < 4 || pin !== pinConfirm)) return;
                setErr("");
                setStep((s) => s + 1);
              }}
              disabled={busy || !canNext}
              className="rounded bg-primary px-5 py-1.5 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              {step === 4 ? "Finish" : "Next"}
            </button>
          ) : (
            <button
              onClick={() => void finish()}
              disabled={busy}
              className="rounded bg-primary px-5 py-1.5 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              {busy ? "Saving…" : "Go to Pulse"}
            </button>
          )}
        </div>
      </div>

      {importKind === "stock" && (
        <ImportStockModal onClose={() => setImportKind(null)} onDone={() => setImportKind(null)} />
      )}
      {importKind === "customers" && (
        <ImportCustomersModal onClose={() => setImportKind(null)} onDone={() => setImportKind(null)} />
      )}
      {importKind === "suppliers" && (
        <ImportSuppliersModal onClose={() => setImportKind(null)} onDone={() => setImportKind(null)} />
      )}
    </div>
  );
}
