import { useState } from "react";
import { useFocusTrap } from "../lib/focusTrap";
import { beep } from "../lib/audio";

interface Props {
  title: string;
  detail?: string;
  /** Return an error message to keep the modal open (wrong PIN etc.), or
   * null/undefined for success — the modal confirms and closes itself. */
  onSubmit(pin: string): string | null | Promise<string | null>;
  onClose(): void;
}

/** Manager-PIN prompt for sensitive actions (voids, refunds). Shown only
 * when a manager PIN is configured in Settings — otherwise actions run
 * without it. The Rust side re-checks every gated command regardless. */
export function PinPromptModal({ title, detail, onSubmit, onClose }: Props) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const dialogRef = useFocusTrap<HTMLDivElement>();

  const submit = async () => {
    if (busy || ok || pin.trim().length < 4) return;
    setBusy(true);
    setErr("");
    try {
      const res = await onSubmit(pin.trim());
      if (res) {
        // Wrong PIN or refused action — stay open so it can be retried.
        setErr(res);
        setPin("");
        beep(false);
      } else {
        setOk(true);
        beep(true);
        setTimeout(onClose, 700);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-dialog-title"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="w-full max-w-xs rounded-xl border border-outline-variant bg-surface p-5 shadow-lg"
      >
        <h3 id="pin-dialog-title" className="mb-1 text-headline-md font-headline-md text-on-surface">
          {title}
        </h3>
        <p className="mb-4 text-body-sm font-body-sm text-on-surface-variant">
          {detail ?? "This action is protected — enter the manager PIN."}
        </p>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          value={pin}
          disabled={busy || ok}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="••••"
          aria-label="Manager PIN"
          className={`h-10 w-full rounded border bg-surface-container-lowest px-3 text-center font-data-mono text-data-mono tracking-[0.4em] text-on-surface focus:outline-none focus:ring-1 ${
            err ? "border-error focus:border-error focus:ring-error" : "border-outline-variant focus:border-primary focus:ring-primary"
          }`}
        />
        {err && (
          <p className="mt-2 text-body-sm font-body-sm text-error" role="alert">
            {err}
          </p>
        )}
        {ok && (
          <p className="mt-2 flex items-center gap-1 text-body-sm font-body-sm text-primary" role="status">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            Accepted
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || ok || pin.trim().length < 4}
            className="rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
          >
            {ok ? "Accepted" : busy ? "Checking…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
