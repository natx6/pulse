import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store/useStore";
import {
  backupDbToDir,
  getSettings,
  isManagerPinSet,
  saveSetting,
  setManagerPin,
  listBackups,
  restoreBackup,
  restoreFromDir,
  restartApp,
  refreshFdaCatalog,
  listUsers,
  createUser,
  updateUser,
  resetUserPassword,
} from "../db";
import type { AppUser, BackupInfo } from "../db";
import { beep } from "../lib/audio";
import { PinPromptModal } from "../components/PinPromptModal";

export function SettingsPage() {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const taxRate = useStore((s) => s.taxRate);
  const receiptFooter = useStore((s) => s.receiptFooter);
  const supportEmail = useStore((s) => s.supportEmail);
  const momoNumber = useStore((s) => s.momoNumber);
  const applySettings = useStore((s) => s.applySettings);

  const [name, setName] = useState(pharmacyName);
  const [tax, setTax] = useState(String(taxRate));
  const [footer, setFooter] = useState(receiptFooter);
  const [support, setSupport] = useState(supportEmail);
  const [momo, setMomo] = useState(momoNumber);
  /** Thermal printer address — receipts can print straight to it (ESC/POS
   * over TCP port 9100), no print dialog. */
  const [printerHost, setPrinterHost] = useState("");
  const [printerPort, setPrinterPort] = useState("9100");
  const isDark = useStore((s) => s.isDark);
  const [saved, setSaved] = useState(false);
  const [settingsErr, setSettingsErr] = useState("");
  /** Manager PIN gate (loss prevention). */
  const [pinActive, setPinActive] = useState(false);
  const [pinInput, setPinInput] = useState("");
  /** Current PIN — required to change/clear an ACTIVE pin. */
  const [currentPinInput, setCurrentPinInput] = useState("");
  const [pinMsg, setPinMsg] = useState("");
  /** Second tap required to actually clear an active PIN. */
  const [pinArmClear, setPinArmClear] = useState(false);
  /** Flash-drive backup. */
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMsg, setDriveMsg] = useState("");
  /** Two-tap confirm for the flash-drive restore (it replaces everything). */
  const [restoreArm, setRestoreArm] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState("");
  /** Backup-list restore awaiting its manager-PIN confirmation. */
  const [pinTargetBackup, setPinTargetBackup] = useState<string | null>(null);
  /** Users — manager adds logins, workers hidden. */
  const currentUser = useStore((s) => s.currentUser);
  const isManager = currentUser?.role === "manager";
  const [users, setUsers] = useState<AppUser[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"manager" | "worker">("worker");
  const [usersErr, setUsersErr] = useState("");

  /** Flash-drive restore awaiting its manager-PIN confirmation. */
  const [pinDriveRestore, setPinDriveRestore] = useState<string | null>(null);

  const [fdaCount, setFdaCount] = useState<number | null>(null);
  const [fdaBusy, setFdaBusy] = useState(false);
  const [fdaMsg, setFdaMsg] = useState("");
  const [fdaProgress, setFdaProgress] = useState<{ current: number; total: number; page: number; totalPages: number } | null>(null);
  const loadFdaCount = async () => {
    try {
      const { initDb } = await import("../db");
      const d = await initDb();
      const rows = await d.select<{ n: number }[]>("SELECT COUNT(*) as n FROM fda_drugs", []);
      setFdaCount(rows[0]?.n ?? 0);
    } catch {
      setFdaCount(0);
    }
  };
  useEffect(() => {
    void loadFdaCount();
  }, []);
  useEffect(() => {
    if (!fdaBusy) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ current: number; total: number; page: number; totalPages: number }>("fda-progress", (e) =>
        setFdaProgress(e.payload),
      ).then((fn) => (unlisten = fn)),
    );
    return () => {
      unlisten?.();
      setFdaProgress(null);
    };
  }, [fdaBusy]);

  useEffect(() => {
    if (!isManager) return;
    listUsers().then(setUsers).catch(() => setUsers([]));
  }, [isManager]);

  const restoreFromDrive = async () => {
    setRestoreMsg("");
    if (!restoreArm) {
      // First tap arms; the second commits. Resets after 5s of inaction.
      setRestoreArm(true);
      window.setTimeout(() => setRestoreArm(false), 5000);
      return;
    }
    setRestoreArm(false);
    try {
      const picked = await openDialog({
        directory: true,
        title: "Pick the folder holding the pulse-*.db + pulse.key pair",
      });
      if (!picked) return; // dialog cancelled
      // Same gate as the backup-list restore: Rust re-verifies regardless of UI.
      if (await isManagerPinSet()) {
        setPinDriveRestore(String(picked));
        return;
      }
      await runDriveRestore(String(picked), null);
    } catch (e) {
      setRestoreMsg(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  /** The actual flash-drive swap. Rethrows so PinPromptModal can render a
   * wrong-PIN failure instead of reporting success. */
  const runDriveRestore = async (dir: string, pin: string | null) => {
    try {
      setRestoreBusy(true);
      await restoreFromDir(dir, pin);
      await restartApp(); // never returns
    } catch (e) {
      setRestoreMsg(String(e).replace(/^Error: /, ""));
      beep(false);
      throw e;
    } finally {
      setRestoreBusy(false);
    }
  };

  useEffect(() => {
    void getSettings().then((s) => {
      setPrinterHost(s.printerHost);
      setPrinterPort(String(s.printerPort));
    });
    void isManagerPinSet().then(setPinActive).catch(() => setPinActive(false));
  }, []);

  const savePin = async () => {
    const p = pinInput.trim();
    // Clearing an active PIN is destructive — arm it first (two taps).
    if (!p && pinActive && !pinArmClear) {
      setPinArmClear(true);
      window.setTimeout(() => setPinArmClear(false), 3000);
      return;
    }
    setPinArmClear(false);
    if (p && !/^\d{4,8}$/.test(p)) {
      setPinMsg("PIN must be 4–8 digits.");
      return;
    }
    if (pinActive && currentPinInput.trim().length < 4) {
      setPinMsg("Enter the current PIN to make this change.");
      return;
    }
    try {
      // The Rust side re-verifies `current` against the stored hash — the UI
      // check above is UX, not the gate.
      await setManagerPin(
        pinActive ? currentPinInput.trim() : null,
        p || null,
        currentUser?.display_name ?? null,
        currentUser?.role ?? null,
      );
      setPinActive(Boolean(p));
      setPinInput("");
      setCurrentPinInput("");
      setPinMsg(p ? "Manager PIN is now active." : "Manager PIN cleared.");
    } catch (e) {
      setPinMsg(String(e).replace(/^Error: /, ""));
    }
  };

  const saveToDrive = async () => {
    setDriveMsg("");
    try {
      const picked = await openDialog({ directory: true, title: "Where should the backup copy go?" });
      if (!picked) return; // dialog cancelled
      setDriveBusy(true);
      const path = await backupDbToDir(String(picked));
      beep(true);
      setDriveMsg(`Backup copied to ${path}`);
    } catch (e) {
      setDriveMsg(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setDriveBusy(false);
    }
  };

  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupErr, setBackupErr] = useState("");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadBackups = async () => {
    try {
      setBackups(await listBackups());
      setBackupErr("");
    } catch (e) {
      setBackupErr(String(e));
    }
  };
  useEffect(() => {
    void loadBackups();
  }, []);

  const fmtSize = (b: number) =>
    b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  const fmtDate = (epoch: number) =>
    epoch ? new Date(epoch * 1000).toLocaleString() : "—";

  /** Two-step restore: tap once to arm, again to run. If a manager PIN is
   * active, a PIN prompt confirms first — the Rust side re-checks it. */
  const armRestore = async (name: string) => {
    if (confirmRestore !== name) {
      setConfirmRestore(name);
      window.setTimeout(() => setConfirmRestore((c) => (c === name ? null : c)), 4000);
      return;
    }
    setConfirmRestore(null);
    try {
      if (await isManagerPinSet()) {
        setPinTargetBackup(name);
        return;
      }
    } catch {
      /* fall through — the Rust gate still protects the command */
    }
    await runRestore(name, null);
  };

  const runRestore = async (name: string, pin: string | null) => {
    setRestoring(true);
    try {
      await restoreBackup(name, pin);
      beep(true);
      await restartApp(); // never resolves — the app relaunches
    } catch (e) {
      setBackupErr(String(e).replace(/^Error: /, ""));
      setRestoring(false);
      beep(false);
      // Rethrow so PinPromptModal.onSubmit can render the failure — a helper
      // that swallows errors makes the modal report success on a wrong PIN.
      throw e;
    }
  };



  const save = async () => {
    setSettingsErr("");
    try {
      await saveSetting("pharmacy_name", name.trim() || "Pulse Pharmacy");
      await saveSetting("tax_rate", tax.trim() || "0");
      await saveSetting("receipt_footer", footer.trim());
      await saveSetting("support_email", support.trim());
      await saveSetting("momo_number", momo.trim());
      await saveSetting("printer_host", printerHost.trim());
      await saveSetting(
        "printer_port",
        String(Math.max(1, Math.floor(Number(printerPort)) || 9100)),
      );
      applySettings({
        pharmacyName: name.trim() || "Pulse Pharmacy",
        taxRate: Number(tax) || 0,
        receiptFooter: footer.trim(),
        supportEmail: support.trim(),
        momoNumber: momo.trim(),
      });
      beep(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setSettingsErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };



  const toggleDark = async () => {
    setSettingsErr("");
    const next = !isDark;
    try {
      await saveSetting("is_dark", next ? "1" : "0");
      applySettings({ isDark: next });
      beep(true);
    } catch (e) {
      setSettingsErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  const fdaAutocomplete = useStore((s) => s.fdaAutocomplete);
  const toggleFdaAutocomplete = async (v: boolean) => {
    setSettingsErr("");
    try {
      await saveSetting("fda_autocomplete", v ? "1" : "0");
      applySettings({ fdaAutocomplete: v });
      beep(true);
    } catch (e) {
      setSettingsErr(String(e).replace(/^Error: /, ""));
      beep(false);
    }
  };

  const field =
    "h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface-container-lowest p-margin-page">
      <div className="mb-6">
        <h2 className="text-headline-lg font-headline-lg text-on-surface">Settings</h2>
        <p className="text-body-sm font-body-sm text-on-surface-variant">
          Receipt details and who works here. Saved locally.
        </p>
      </div>

      {settingsErr && (
        <p className="mb-4 max-w-xl rounded border border-error/30 bg-error/5 px-3 py-2 text-body-sm font-body-sm text-error">
          {settingsErr}
        </p>
      )}

      <div className="max-w-xl">
        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Pharmacy name
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Tax rate (%) — 0 disables the tax line
          </span>
          <input
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            inputMode="decimal"
            className={field}
          />
        </label>
        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Receipt footer
          </span>
          <input
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            className={field}
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Support email — where the Support page sends problem reports
          </span>
          <input
            value={support}
            onChange={(e) => setSupport(e.target.value)}
            type="email"
            placeholder="support@example.com"
            className={field}
          />
        </label>
        <label className="mb-6 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Mobile Money number — shown on the payment screen and receipts so
            customers know where to pay
          </span>
          <input
            value={momo}
            onChange={(e) => setMomo(e.target.value)}
            placeholder="e.g. 024 000 0000"
            className={field}
          />
        </label>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <h3 className="mb-1 text-headline-md font-headline-md text-on-surface">
            Thermal printer (optional)
          </h3>
          <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
            Receipts print straight to an ESC/POS printer on the shop's
            network — no print dialog. Set its IP address and port (9100 is
            the default for networked and router-shared USB printers).
          </p>
          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="mb-1 block text-body-md font-body-md text-on-surface">
                Printer address
              </span>
              <input
                value={printerHost}
                onChange={(e) => setPrinterHost(e.target.value)}
                placeholder="e.g. 192.168.1.50"
                className={`${field} font-data-mono`}
              />
            </label>
            <label className="block w-28">
              <span className="mb-1 block text-body-md font-body-md text-on-surface">Port</span>
              <input
                value={printerPort}
                onChange={(e) => setPrinterPort(e.target.value)}
                inputMode="numeric"
                placeholder="9100"
                className={`${field} font-data-mono`}
              />
            </label>
          </div>
        </div>

        {isManager && (
          <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
            <h3 className="mb-3 text-headline-md font-headline-md text-on-surface">Logins — manager adds workers</h3>
            <p className="mb-3 text-body-sm text-on-surface-variant">
              Manager sees everything; workers see only <span className="font-medium">POS, Inventory (browse), Customers (browse), Support</span>. Hidden, not greyed out.
            </p>
            <div className="mb-3 divide-y divide-outline-variant/50 rounded border border-outline-variant">
              {users.length === 0 && <p className="p-3 text-body-sm text-on-surface-variant">No logins yet — the default is manager / manager.</p>}
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-body-sm font-semibold text-on-surface">
                      {u.display_name} <span className="font-data-mono text-[11px] text-on-surface-variant">@{u.username}</span>
                      <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${u.role === "manager" ? "bg-primary/10 text-primary" : "bg-surface-variant text-on-surface-variant"}`}>{u.role}</span>
                      {u.is_active ? null : <span className="ml-1 rounded bg-error/10 px-1 py-0.5 text-[10px] text-error">deactivated</span>}
                      {u.must_change_password ? <span className="ml-1 text-[10px] text-warn">must change</span> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={async () => {
                        const pw = window.prompt(`New password for @${u.username} (min 4):`);
                        if (!pw || pw.length < 4) return;
                        try {
                          await resetUserPassword(
                            u.id,
                            pw,
                            currentUser?.display_name ?? null,
                            currentUser?.role ?? null,
                          );
                          beep(true);
                          setUsers(await listUsers());
                        } catch (e) {
                          setUsersErr(String(e).replace(/^Error: /, ""));
                          beep(false);
                        }
                      }}
                      className="rounded border border-outline-variant px-2 py-1 text-[11px] text-on-surface hover:bg-surface-variant"
                    >
                      Reset PW
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await updateUser(
                            u.id,
                            { is_active: !u.is_active },
                            currentUser?.display_name ?? null,
                            currentUser?.role ?? null,
                          );
                          setUsers(await listUsers());
                          beep(true);
                        } catch (e) {
                          setUsersErr(String(e).replace(/^Error: /, ""));
                          beep(false);
                        }
                      }}
                      className={`rounded px-2 py-1 text-[11px] ${u.is_active ? "border border-error/30 text-error hover:bg-error/10" : "border border-primary/30 text-primary hover:bg-primary/10"}`}
                    >
                      {u.is_active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {usersErr && <p className="mb-2 text-body-sm text-error">{usersErr}</p>}
            <div className="flex flex-wrap items-end gap-2 rounded bg-surface-container-low p-3">
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Username</span>
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder="e.g. ama" className="h-8 w-28 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Display name</span>
                <input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder="Ama" className="h-8 w-32 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Temp password</span>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••" className="h-8 w-24 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm tracking-[0.2em] focus:border-primary focus:outline-none" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Role</span>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)} className="h-8 rounded border border-outline-variant bg-surface-container-lowest px-2 text-body-sm focus:border-primary focus:outline-none">
                  <option value="worker">worker</option>
                  <option value="manager">manager</option>
                </select>
              </label>
              <button
                onClick={async () => {
                  setUsersErr("");
                  try {
                    await createUser(
                      newUsername.trim(),
                      newDisplayName.trim(),
                      newPassword,
                      newRole,
                      currentUser?.display_name ?? null,
                      currentUser?.role ?? null,
                    );
                    setNewUsername("");
                    setNewDisplayName("");
                    setNewPassword("");
                    setUsers(await listUsers());
                    beep(true);
                  } catch (e) {
                    setUsersErr(String(e).replace(/^Error: /, ""));
                    beep(false);
                  }
                }}
                className="h-8 rounded bg-primary px-4 text-label-md font-label-md text-on-primary hover:bg-on-primary-fixed-variant"
              >
                Add login
              </button>
            </div>
          </div>
        )}

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-headline-md font-headline-md text-on-surface">Backups</h3>
            <div className="flex gap-2">
              <button
                onClick={() => void saveToDrive()}
                disabled={driveBusy}
                title="Copy the database to a flash drive or second disk — insurance against theft or fire"
                className="rounded border border-primary/40 bg-primary/5 px-2 py-1 text-label-md font-label-md text-primary hover:bg-primary/10 disabled:opacity-50"
                data-tour="tour-backup"
              >
                {driveBusy ? "Copying…" : "Save to flash drive…"}
              </button>
              <button
                onClick={() => void loadBackups()}
                className="rounded border border-outline-variant px-2 py-1 text-label-md font-label-md text-on-surface-variant hover:bg-surface-variant"
              >
                Refresh
              </button>
            </div>
          </div>
          {driveMsg && (
            <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm break-all text-primary">
              {driveMsg}
            </p>
          )}
          <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
            Automatic backups run after every 10th sale, on app exit, and via
            the Reports page. The newest 20 are kept. Restoring swaps the
            database — the current data is backed up first, then the app
            restarts.
          </p>
          <p className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm font-body-sm text-primary">
            Your data is encrypted. "Save to flash drive…" copies{" "}
            <span className="font-data-mono">pulse.key</span> next to the
            backup — keep the two together: a backup without its key file can
            never be opened.
          </p>
          {/* Disaster recovery: move this pharmacy onto THIS machine from a
              flash-drive pair. Replaces everything on this install. */}
          <div className="mb-3 rounded border border-outline-variant bg-surface-container-low p-3">
            <p className="text-body-md font-body-md text-on-surface">
              Moving to a new computer?
            </p>
            <p className="mt-1 mb-3 text-body-sm font-body-sm text-on-surface-variant">
              Install Pulse here, plug in the flash drive, then tap Restore.
              Everything on this machine is replaced with the flash drive's
              copy — sales, patients, credit books, all of it.
            </p>
            <button
              onClick={() => void restoreFromDrive()}
              disabled={restoreBusy}
              className={`h-9 rounded px-4 text-label-md font-label-md shadow-sm transition-colors disabled:opacity-50 ${
                restoreArm
                  ? "bg-error text-on-error hover:bg-error/90"
                  : "border border-outline-variant bg-surface text-on-surface hover:bg-surface-variant"
              }`}
            >
              {restoreBusy
                ? "Restoring…"
                : restoreArm
                  ? "Tap again to replace everything"
                  : "Restore from flash drive…"}
            </button>
            {restoreMsg && (
              <p className="mt-2 text-body-sm font-body-sm text-error" role="alert">
                {restoreMsg}
              </p>
            )}
          </div>
          <div className="mt-3 rounded border border-outline-variant bg-surface-container-low p-3">
            <p className="text-body-md font-body-md text-on-surface">FDA Ghana catalog</p>
            <p className="mt-1 mb-2 text-body-sm font-body-sm text-on-surface-variant">
              {fdaCount === null ? "Loading…" : `${fdaCount.toLocaleString()} DRUG/DRUGS from FDA Ghana for autocomplete.`}{" "}
              Updates once a year when FDA registers new drugs. Works fully offline after the first pull.
            </p>
            <label className="mb-3 flex items-center justify-between">
              <span className="text-body-sm font-body-sm text-on-surface">Enable FDA autocomplete in add forms</span>
              <input
                type="checkbox"
                checked={fdaAutocomplete}
                onChange={(e) => void toggleFdaAutocomplete(e.target.checked)}
                className="h-4 w-8 accent-primary"
              />
            </label>
            <button
              onClick={async () => {
                setFdaBusy(true);
                setFdaMsg("");
                try {
                  const n = await refreshFdaCatalog(
                    currentUser?.display_name ?? null,
                    currentUser?.role ?? null,
                  );
                  beep(true);
                  setFdaMsg(`Updated — ${n.toLocaleString()} drugs. You can now type 2 letters in “Add Manual Item” to see matches.`);
                  await loadFdaCount();
                } catch (e) {
                  setFdaMsg(String(e).replace(/^Error: /, ""));
                  beep(false);
                } finally {
                  setFdaBusy(false);
                }
              }}
              disabled={fdaBusy}
              className="h-9 rounded border border-primary/40 bg-primary/5 px-4 text-label-md font-label-md text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {fdaBusy ? "Updating… (30-60s, needs internet)" : "Update FDA catalog"}
            </button>
            {fdaBusy && fdaProgress && (
              <div className="mt-2">
                <div className="h-2 overflow-hidden rounded-full bg-surface-variant">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${fdaProgress.total ? Math.round((fdaProgress.current / Math.max(1, fdaProgress.total)) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="mt-1 font-data-mono text-[11px] text-on-surface-variant">
                  {fdaProgress.current.toLocaleString()} / {fdaProgress.total.toLocaleString()} · page {fdaProgress.page} / {fdaProgress.totalPages || "…"}
                </p>
              </div>
            )}
            {fdaMsg && <p className="mt-2 text-body-sm font-body-sm text-on-surface-variant">{fdaMsg}</p>}
          </div>


          {backupErr && (
            <p className="mb-2 text-body-sm font-body-sm text-error">{backupErr}</p>
          )}
          {backups.length === 0 && !backupErr && (
            <p className="py-3 text-center text-body-sm text-on-surface-variant">
              No backups yet — hit Backup on the Reports page.
            </p>
          )}
          <div className="max-h-[240px] overflow-y-auto">
          {backups.slice(0, 10).map((b) => (
            <div key={b.name} className="flex items-center gap-2 border-b border-outline-variant/50 py-1.5 last:border-0">
              <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                database
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-data-mono text-data-mono text-on-surface">
                  {b.name}
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  {fmtSize(b.size)} · {fmtDate(b.modified)}
                </p>
              </div>
              <button
                onClick={() => armRestore(b.name)}
                disabled={restoring}
                title="Restore this backup — current data is saved first, app restarts"
                className={`h-8 w-20 shrink-0 rounded text-label-md font-label-md transition-colors disabled:opacity-50 ${
                  confirmRestore === b.name
                    ? "bg-error/10 text-error hover:bg-error/20"
                    : "border border-outline-variant text-on-surface hover:bg-surface-variant"
                }`}
              >
                {restoring && confirmRestore === b.name
                  ? "Restoring…"
                  : confirmRestore === b.name
                    ? "Restore?"
                    : "Restore"}
              </button>
            </div>
          ))}
          </div>
          {backups.length > 10 && (
            <p className="pt-2 text-[11px] text-on-surface-variant">
              +{backups.length - 10} older backup{backups.length - 10 === 1 ? "" : "s"} not shown here
              (up to 20 are kept on disk)
            </p>
          )}
        </div>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-headline-md font-headline-md text-on-surface">
              Loss prevention
            </h3>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                pinActive ? "bg-primary/10 text-primary" : "bg-surface-container-highest text-on-surface-variant"
              }`}
            >
              {pinActive ? "PIN active" : "No PIN"}
            </span>
          </div>
          <p className="mb-3 text-body-sm font-body-sm text-on-surface-variant">
            When a manager PIN is set, voiding, refunds, supplier payments,
            credit settlements and stock reductions all ask for it first — so
            day-to-day counter work stays untouched while the sensitive paths
            are watched. The PIN itself is stored only as a salted hash.
          </p>
          {pinActive && (
            <label className="mb-3 block max-w-xs">
              <span className="mb-1 block text-body-md font-body-md text-on-surface">
                Current PIN (required to change or clear)
              </span>
              <input
                type="password"
                inputMode="numeric"
                value={currentPinInput}
                onChange={(e) => setCurrentPinInput(e.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="Current PIN"
                className={`${field} font-data-mono tracking-[0.3em]`}
              />
            </label>
          )}
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="mb-1 block text-body-md font-body-md text-on-surface">
                {pinActive ? "Change or clear the manager PIN" : "Set a manager PIN (4–8 digits)"}
              </span>
              <input
                type="password"
                inputMode="numeric"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder={pinActive ? "New PIN — leave blank to keep" : "e.g. 2468"}
                className={`${field} font-data-mono tracking-[0.3em]`}
              />
            </label>
            <button
              onClick={() => void savePin()}
              disabled={!pinInput.trim() && !pinActive}
              className={`h-9 shrink-0 rounded px-4 text-label-md font-label-md shadow-sm transition-colors ${
                pinArmClear
                  ? "bg-error text-on-error hover:opacity-90"
                  : "bg-primary text-on-primary hover:bg-on-primary-fixed-variant"
              } disabled:opacity-50`}
            >
              {pinInput.trim()
                ? "Save PIN"
                : pinActive
                  ? pinArmClear
                    ? "Really clear?"
                    : "Clear PIN"
                  : "Set PIN"}
            </button>
          </div>
          {pinMsg && (
            <p className="mt-2 text-body-sm font-body-sm text-on-surface-variant">{pinMsg}</p>
          )}
        </div>

        <div className="mb-6 rounded-xl border border-outline-variant bg-surface p-4">
          <h3 className="mb-3 text-headline-md font-headline-md text-on-surface">Appearance</h3>
          <label className="flex items-center gap-3">
            <button
              onClick={() => void toggleDark()}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                isDark ? "bg-primary" : "bg-surface-variant"
              }`}
              role="switch"
              aria-checked={isDark}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  isDark ? "translate-x-5" : ""
                }`}
              />
            </button>
            <span className="text-body-md font-body-md text-on-surface">
              Dark mode
            </span>
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
              {isDark ? "dark_mode" : "light_mode"}
            </span>
          </label>
        </div>

        <button
          onClick={() => void save()}
          className="rounded bg-primary px-6 py-2 text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
        >
          <span className="text-label-md font-label-md">
            {saved ? "Saved ✓" : "Save"}
          </span>
        </button>
      </div>

      {pinTargetBackup !== null && (
        <PinPromptModal
          title="Restore backup"
          detail={`Restoring "${pinTargetBackup}" replaces the whole database — today's sales included. Enter the manager PIN to continue.`}
          onSubmit={async (pin) => {
            try {
              await runRestore(pinTargetBackup, pin);
              return null;
            } catch (e) {
              return String(e).replace(/^Error: /, "");
            }
          }}
          onClose={() => setPinTargetBackup(null)}
        />
      )}

      {pinDriveRestore !== null && (
        <PinPromptModal
          title="Restore from flash drive"
          detail="Restoring this backup replaces the whole database — today's sales included. Enter the manager PIN to continue."
          onSubmit={async (pin) => {
            try {
              await runDriveRestore(pinDriveRestore, pin);
              return null;
            } catch (e) {
              return String(e).replace(/^Error: /, "");
            }
          }}
          onClose={() => setPinDriveRestore(null)}
        />
      )}


    </div>
  );
}
