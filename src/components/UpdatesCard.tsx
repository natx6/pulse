import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate } from "../lib/updater";
import { beep } from "../lib/audio";

/** Updates card (Settings, manager-only): current version, manual
 * re-check, and the last result in plain words — so a failed launch-time
 * check is diagnosable without relaunching. */
export function UpdatesCard() {
  const [version, setVersion] = useState("…");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [isErr, setIsErr] = useState(false);

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
      const found = await checkForUpdate();
      setIsErr(false);
      if (found) {
        setMsg(`v${found.version} is ready — look for the update bar at the top.`);
        beep(true);
      } else {
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

  return (
    <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
      <h3 className="mb-1 text-headline-md font-headline-md text-on-surface">Updates</h3>
      <p className="mb-3 font-data-mono text-data-mono text-on-surface-variant">
        Installed: Pulse v{version}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void doCheck()}
          disabled={busy}
          className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check for updates"}
        </button>
        {msg && (
          <p className={`text-body-sm font-body-sm ${isErr ? "text-error" : "text-on-surface-variant"}`}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
