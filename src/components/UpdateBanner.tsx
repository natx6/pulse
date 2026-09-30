import { useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AvailableUpdate } from "../lib/updater";

/** Persistent "a new version is ready" bar. The worker picks the moment —
 * updates never download or restart the app uninvited mid-shift. */
export function UpdateBanner({
  update,
  onDone,
}: {
  update: AvailableUpdate;
  onDone(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const doUpdate = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await update.install((p) => setPct(p));
      await relaunch();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2">
      <span className="material-symbols-outlined text-[20px] text-primary">system_update</span>
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-body-sm font-bold text-on-surface">
          Pulse v{update.version} is ready
          {busy && pct !== null ? ` — downloading ${pct}%` : ""}
          {busy && pct === null ? " — downloading…" : ""}
        </p>
        {update.notes && !busy && (
          <p className="truncate text-body-sm font-body-sm text-on-surface-variant">{update.notes}</p>
        )}
        {err && <p className="text-body-sm font-body-sm text-error">{err}</p>}
        {busy && (
          <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-variant">
            <div
              className={`h-full rounded-full bg-primary transition-all${pct === null ? " animate-pulse" : ""}`}
              style={{ width: pct === null ? "33%" : `${pct}%` }}
            />
          </div>
        )}
      </div>
      {!busy && (
        <>
          <button
            onClick={() => void doUpdate()}
            className="shrink-0 rounded bg-primary px-4 py-1.5 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
          >
            Update now
          </button>
          <button
            onClick={onDone}
            title="Keep this version for now — the bar comes back next launch"
            className="shrink-0 rounded border border-outline-variant px-3 py-1.5 text-label-md font-label-md text-on-surface-variant hover:bg-surface-variant"
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
