import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
  /** Optional undo callback — renders an "Undo" button. */
  undo?: () => void;
  /** Auto-dismiss in ms (default 3000). */
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, type?: Toast["type"], opts?: { undo?: () => void; duration?: number }) => void;
  dismiss: (id: number) => void;
}

let _next = 1;

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message, type = "success", opts) => {
    const id = _next++;
    const t: Toast = { id, message, type, ...opts };
    set({ toasts: [...get().toasts, t] });
    const dur = opts?.duration ?? 3000;
    if (dur > 0) {
      setTimeout(() => {
        set({ toasts: get().toasts.filter((x) => x.id !== id) });
      }, dur);
    }
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}));
