import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { checkForUpdate, type AvailableUpdate } from "../lib/updater";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";

/** Updates card (Settings, manager-only): current version, manual
 * re-check, and install-from-here. A found update also raises the top
 * banner — both buttons install the same object. */
export function UpdatesCard() {
  const [version, setVersion] = useState("…");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [isErr, setIsErr] = useState(false);
  const [found, setFound] = useState<AvailableUpdate | null>(null);
  const setAvailableUpdate = useStore((s) => s.setAvailableUpdate);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
  }, []);

  const doCheck = async () => {
    if (busy) return;
    if (import.meta.env.DEV) {
      setIsErr(false);
      setMsg("Dev build — install the app to check for updates.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const update = await checkForUpdate();
      setIsErr(false);
      if (update) {
        setFound(update);
        setAvailableUpdate(update);
        setMsg(`v${update.version} is ready — update from the bar above or right here.`);
        beep(true);
      } else {
        setFound(null);
        setMsg(`You're on the newest version (v${version}).`);
      }
    } catch (e) {
      setIsErr(true);
      setMsg(String(e instanceof Error ? e.message : e));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  const doInstall = async () => {
    if (!found || installing) return;
    setInstalling(true);
    setIsErr(false);
    setMsg("");
    try {
      await found.install((p) => setPct(p));
      await relaunch();
    } catch (e) {
      setIsErr(true);
      setMsg(String(e instanceof Error ? e.message : e));
      setInstalling(false);
      beep(false);
    }
  };

  return (
    <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
      <h3 className="mb-1 text-headline-md font-headline-md text-on-surface">Updates</h3>
      <p className="mb-3 font-data-mono text-data-mono text-on-surface-variant">
        Installed: Pulse v{version}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void doCheck()}
          disabled={busy || installing}
          className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check for updates"}
        </button>
        {found && (
          <button
            onClick={() => void doInstall()}
            disabled={installing}
            className="rounded border border-primary bg-primary/10 px-4 py-2 text-label-md font-label-md text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {installing
              ? pct !== null
                ? `Updating… ${pct}%`
                : "Updating…"
              : `Update to v${found.version}`}
          </button>
        )}
        {msg && (
          <p className={`text-body-sm font-body-sm ${isErr ? "text-error" : "text-on-surface-variant"}`}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
