import { useState } from "react";
import { addPatient } from "../db";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";

interface Props {
  onClose(): void;
}

/** Register a customer (name + phone, optional email) and attach them to the
 *  current sale. Reuses the QuickAddModal look: icon header, fields, footer. */
export function AddCustomerModal({ onClose }: Props) {
  const setPatient = useStore((s) => s.setPatient);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      beep(false);
      return;
    }
    if (!phone.trim()) {
      setError("Phone number is required.");
      beep(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addPatient(name, email, phone);
      setPatient({ name: name.trim(), phone: phone.trim() });
      beep(true);
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary-container p-1.5 text-on-primary-container">
              <span className="material-symbols-outlined text-[20px]">person_add</span>
            </div>
            <div>
              <h3 className="text-headline-md font-headline-md text-on-surface">Add Customer</h3>
              <p className="text-body-sm font-body-sm text-on-surface-variant">
                New customer — attached to this sale after saving.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ama Mensah"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Phone number
            </span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 0244 000 000"
              inputMode="tel"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-label-md font-label-md text-on-surface">
              Email <span className="text-on-surface-variant">(optional)</span>
            </span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. ama@example.com"
              inputMode="email"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          {error && <p className="text-body-sm font-body-sm text-error">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="rounded border border-outline px-4 py-2 text-on-surface transition-colors hover:bg-surface-variant"
            >
              <span className="text-label-md font-label-md">Cancel</span>
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant disabled:opacity-50"
            >
              <span className="text-label-md font-label-md">Add & Attach</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
