import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { activeOperatorAt } from "../lib/shift";
import { Tip } from "./Tip";
import type { PageId } from "../types";

const NAV: { id: PageId; icon: string; label: string }[] = [
  { id: "pos", icon: "point_of_sale", label: "POS" },
  { id: "inventory", icon: "inventory_2", label: "Inventory" },
  { id: "restock", icon: "shopping_cart", label: "Requisitions" },
  { id: "analytics", icon: "bar_chart", label: "Reports" },
  { id: "expenses", icon: "receipt_long", label: "Expenses" },
  { id: "support", icon: "support_agent", label: "Support" },
];

export function Sidebar() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const newSale = useStore((s) => s.newSale);
  const operator = useStore((s) => s.operator);
  const operators = useStore((s) => s.operators);
  const autoOperator = useStore((s) => s.autoOperator);
  const loadOperators = useStore((s) => s.loadOperators);
  const setOperator = useStore((s) => s.setOperator);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    void loadOperators();
  }, [loadOperators]);

  const activeShift = autoOperator ? activeOperatorAt(operators) : null;
  const sub = activeShift
    ? `Auto · ${activeShift.name} until ${activeShift.shift_end}`
    : autoOperator
      ? "Auto on — no shift covers now"
      : operator
        ? "On duty — tap to switch"
        : "Tap to set operator";

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

      <Tip label="Fresh sale — holds the current order and clears the counter">
        <button
          onClick={newSale}
          className="mb-6 flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-on-primary transition-colors hover:opacity-90 active:opacity-80"
        >
          <span className="material-symbols-outlined filled text-[18px]">add_circle</span>
          <span className="text-label-md font-label-md">New Prescription</span>
        </button>
      </Tip>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((n) => {
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
        <button
          onClick={() => setPage("settings")}
          className="group flex items-center gap-3 rounded-xl px-3 py-2 text-left text-white/60 transition-colors duration-150 hover:bg-white/10 hover:text-white"
        >
          <span className="material-symbols-outlined text-[20px] transition-transform group-hover:scale-110">
            settings
          </span>
          <span className="text-label-md font-label-md">Settings</span>
        </button>
        <div className="relative mt-4 px-3">
          <Tip label="Tap to switch who is on duty" dir="top">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              className="flex w-full items-center gap-3 rounded p-0 text-left transition-colors hover:bg-white/5"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-white/20 bg-white/10 text-xs font-bold text-white">
                {operator ? operator.charAt(0).toUpperCase() : "?"}
              </div>
              <div className="min-w-0">
                <span className="block truncate text-[12px] font-semibold text-white">
                  {operator || "No operator set"}
                </span>
                <span className="block text-[10px] text-white/50">{sub}</span>
              </div>
              <span className="material-symbols-outlined ml-auto text-[14px] text-white/50">
                expand_more
              </span>
            </button>
          </Tip>

          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
              <div className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
                <div className="border-b border-outline-variant bg-surface-container-low px-3 py-2 text-label-md font-label-md uppercase tracking-wider text-on-surface-variant">
                  Who is on duty?
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  <button
                    onClick={() => {
                      setOperator("");
                      setPickerOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm hover:bg-surface-container-low ${
                      operator === "" ? "bg-primary/10 font-semibold text-primary" : "text-on-surface"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">person_off</span>
                    No operator
                  </button>
                  {operators.map((op) => (
                    <button
                      key={op.id}
                      onClick={() => {
                        setOperator(op.name);
                        setPickerOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm hover:bg-surface-container-low ${
                        operator === op.name
                          ? "bg-primary/10 font-semibold text-primary"
                          : "text-on-surface"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">badge</span>
                      <span className="min-w-0 flex-1 truncate">{op.name}</span>
                      {op.shift_start && op.shift_end && (
                        <span className="shrink-0 text-[10px] text-on-surface-variant">
                          {op.shift_start}–{op.shift_end}
                        </span>
                      )}
                      {autoOperator && activeShift?.id === op.id && (
                        <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-bold text-primary">
                          auto now
                        </span>
                      )}
                    </button>
                  ))}
                  {operators.length === 0 && (
                    <p className="px-3 py-3 text-center text-body-sm text-on-surface-variant">
                      No operators yet.
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setPickerOpen(false);
                    setPage("settings");
                  }}
                  className="flex w-full items-center gap-2 border-t border-outline-variant bg-surface-container-low px-3 py-2 text-left text-label-md font-label-md text-primary hover:bg-surface-container-lowest"
                >
                  <span className="material-symbols-outlined text-[16px]">settings</span>
                  Manage operators in Settings
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
