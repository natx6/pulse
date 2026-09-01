import { useState } from "react";
import { useStore } from "../store/useStore";
import { changeOwnPassword, verifyManagerPin } from "../db";
import { PinPromptModal } from "./PinPromptModal";
import type { PageId } from "../types";

const NAV: { id: PageId; icon: string; label: string }[] = [
  { id: "dashboard", icon: "space_dashboard", label: "Dashboard" },
  { id: "pos", icon: "point_of_sale", label: "POS" },
  { id: "history", icon: "history", label: "History" },
  { id: "customers", icon: "groups", label: "Customers" },
  { id: "inventory", icon: "inventory_2", label: "Inventory" },
  { id: "restock", icon: "shopping_cart", label: "Requisitions" },
  { id: "analytics", icon: "bar_chart", label: "Reports" },
  { id: "expenses", icon: "receipt_long", label: "Expenses" },
  { id: "support", icon: "support_agent", label: "Support" },
];

export function Sidebar() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const role = useStore((s) => s.role);
  const setRole = useStore((s) => s.setRole);
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwOk, setPwOk] = useState(false);
  const currentUser = useStore((s) => s.currentUser);
  const logout = useStore((s) => s.logout);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Manager-PIN prompt for unlocking Manager mode. */
  const [unlockOpen, setUnlockOpen] = useState(false);

  const isWorker = currentUser?.role === "worker";
  const visibleNav = isWorker
    ? NAV.filter((n) => ["dashboard", "pos", "history", "customers", "inventory", "support"].includes(n.id))
    : NAV;

  return (
    <nav className="fixed left-0 top-0 z-30 flex h-screen w-64 flex-col bg-[#191c20] px-gutter py-density-medium text-primary-fixed">
      <div className="mb-8 mt-2 flex items-center gap-3 px-2">
        <div className="flex h-10 w-10 items-center justify-center rounded bg-primary text-headline-md font-bold text-on-primary">
          P
        </div>
        <div>
          <h1 className="text-headline-lg font-headline-lg leading-none tracking-tight">
            Pulse
          </h1>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-white/50">
            Pharmacy MS
          </p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {visibleNav.map((n) => {
          const active = page === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 ${
                active
                  ? "bg-white/15 text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white"
              }`}
            >
              <span
                className={`material-symbols-outlined text-[20px] transition-transform group-hover:scale-110 ${
                  active ? "filled" : ""
                }`}
              >
                {n.icon}
              </span>
              <span className="text-label-md font-label-md">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t border-outline/30 pt-4">
        {!isWorker && (
          <button
            onClick={() => setPage("settings")}
            className="group flex items-center gap-3 rounded-xl px-3 py-2 text-left text-white/60 transition-colors duration-150 hover:bg-white/10 hover:text-white"
          >
            <span className="material-symbols-outlined text-[20px] transition-transform group-hover:scale-110">
              settings
            </span>
            <span className="text-label-md font-label-md">Settings</span>
          </button>
        )}
        <div className="relative mt-4 px-3">
          <div className="flex w-full items-center gap-3 rounded p-0 text-left">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-white/20 bg-white/10 text-xs font-bold text-white">
              {currentUser ? currentUser.display_name.charAt(0).toUpperCase() : "?"}
            </div>
            <div className="min-w-0">
              <span className="flex items-center gap-1">
                <span className="block truncate text-[12px] font-semibold text-white">
                  {currentUser ? currentUser.display_name : "No user"}
                </span>
                <span
                  className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase tracking-wider ${
                    role === "manager" ? "bg-primary/25 text-primary-fixed" : "bg-white/10 text-white/60"
                  }`}
                >
                  {role}
                </span>
              </span>
              <span className="block truncate text-[10px] text-white/50">
                @{currentUser?.username ?? "—"}
              </span>
            </div>
          </div>

          {currentUser && (
            <>
              <button
                onClick={() => setPwOpen(true)}
                className="relative z-50 mt-2 flex w-full items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-left text-label-md font-label-md text-white/70 hover:bg-white/10 hover:text-white"
              >
                <span className="material-symbols-outlined text-[18px]">key</span>
                Change password
              </button>
              <button
                onClick={() => {
                  logout();
                  setPage("dashboard");
                  setPickerOpen(false);
                }}
                className="relative z-50 mt-2 flex w-full items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-left text-label-md font-label-md text-white/70 hover:bg-white/10 hover:text-white"
              >
                <span className="material-symbols-outlined text-[18px]">logout</span>
                Sign out — {currentUser.display_name}
              </button>
            </>
          )}
          {/* Legacy PIN gate kept for upgrades from pre-users builds where no
              login exists yet — hidden once a user is logged in. */}
          {!currentUser && pickerOpen && (
            <button
              onClick={() => {
                if (role === "manager") {
                  setPickerOpen(false);
                  setRole("cashier");
                  if (page === "settings") setPage("dashboard");
                } else {
                  setPickerOpen(false);
                  setUnlockOpen(true);
                }
              }}
              className={`relative z-50 mt-2 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-label-md font-label-md transition-colors ${
                role === "manager"
                  ? "text-white/70 hover:bg-white/10 hover:text-white"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {role === "manager" ? "lock" : "admin_panel_settings"}
              </span>
              {role === "manager" ? "Lock — back to cashier" : "Unlock Manager mode"}
            </button>
          )}
        </div>
      </div>

      {pwOpen && currentUser && (
        <div data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-5 shadow-lg">
            <h3 className="text-headline-md font-headline-md text-on-surface">Change password</h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">Signed in as @{currentUser.username}</p>
            <label className="mt-3 block">
              <span className="mb-1 block text-label-md text-on-surface">Current password</span>
              <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} placeholder="••••" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono tracking-[0.3em] focus:border-primary focus:outline-none" />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-label-md text-on-surface">New password (min 4)</span>
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="••••" className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono tracking-[0.3em] focus:border-primary focus:outline-none" />
            </label>
            {pwErr && <p className="mt-2 text-body-sm text-error">{pwErr}</p>}
            {pwOk && <p className="mt-2 text-body-sm text-primary">Password changed.</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { setPwOpen(false); setOldPw(""); setNewPw(""); setPwErr(""); setPwOk(false); }} className="rounded border border-outline px-4 py-2 text-label-md text-on-surface hover:bg-surface-variant">Cancel</button>
              <button
                onClick={async () => {
                  setPwErr(""); setPwOk(false);
                  try {
                    await changeOwnPassword(currentUser.username, oldPw, newPw);
                    setPwOk(true);
                    setOldPw(""); setNewPw("");
                    setTimeout(() => { setPwOpen(false); setPwOk(false); }, 1200);
                  } catch (e) {
                    setPwErr(String(e).replace(/^Error: /, ""));
                  }
                }}
                className="rounded bg-primary px-4 py-2 text-label-md text-on-primary hover:bg-on-primary-fixed-variant"
              >
                Change
              </button>
            </div>
          </div>
        </div>
      )}

      {unlockOpen && (
        <PinPromptModal
          title="Unlock Manager mode"
          detail="Enter the manager PIN to reach Settings."
          onSubmit={async (pin) => {
            const ok = await verifyManagerPin(pin).catch(() => false);
            if (!ok) return "Wrong PIN — try again.";
            setRole("manager");
            // The point of unlocking is to manage — land on Settings no
            // matter which tab the previous operator left open.
            setPage("settings");
            return null;
          }}
          onClose={() => setUnlockOpen(false)}
        />
      )}
    </nav>
  );
}
