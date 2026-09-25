import { create } from "zustand";
import type { CartLine, PageId, Patient, Product, Role } from "../types";
import { loadOperators as dbLoadOperators, loadProducts, saveSetting, refreshFdaCatalog } from "../db";
import type { AppUser, Operator } from "../db";

/** Progress payload emitted by the Rust FDA refresh (fda-progress event). */
export interface FdaProgress {
  current: number;
  total: number;
  page: number;
  totalPages: number;
}

/** Global FDA catalog refresh job. Lives in the store (not SettingsPage
 * state) so switching tabs never kills it: the Rust command keeps running,
 * progress keeps flowing via the App-level listener, and the result message
 * is still here when the user comes back. */
export interface FdaJob {
  status: "idle" | "running" | "done" | "error";
  progress: FdaProgress | null;
  message: string;
}

interface AppState {
  page: PageId;
  cart: CartLine[];
  patient: Patient | null;
  products: Product[];
  productsLoaded: boolean;
  taxRate: number;
  pharmacyName: string;
  operator: string;
  receiptFooter: string;
  autoOperator: boolean;
  operators: Operator[];
  supportEmail: string;
  momoNumber: string;
  isDark: boolean;
  /** True once the first-run setup wizard has been completed (persisted as the
   * "setup_complete" setting). Drives whether the wizard shows on launch. */
  setupComplete: boolean;
  /** First-run product tour: true once the user has seen (or skipped) it. */
  tourSeen: boolean;
  /** Forces the tour open (e.g. from Support) even after tourSeen is true. */
  tourOpen: boolean;
  fdaAutocomplete: boolean;
  heldCart: CartLine[] | null;
  searchQuery: string;
  quickAdd: { barcode: string | null } | null;
  intakeOpen: boolean;
  currentUser: AppUser | null;
  /** Effective privilege: mirrors the logged-in account's role (owner /
   * manager / mca), or the legacy PIN-mode for pre-users upgrades with no
   * login yet. Gates should read this, identity UI should read currentUser. */
  role: Role;
  /** Maximum per-sale discount % (manager-set ceiling, from settings). */
  maxDiscountPct: number;
  /** FDA catalog refresh job — survives tab switches (see FdaJob). */
  fdaJob: FdaJob;

  /** Deep-link target set when following a notification: the destination page
   * pulses the matching row. `n` is a nonce so re-clicking the same item
   * re-triggers the animation. */
  highlight: { kind: "product" | "purchase"; id: number | string; n: number } | null;

  setHighlight(h: AppState["highlight"]): void;
  /** Spotlight a specific row after jumping to its page from a notification. */
  flash(kind: "product" | "purchase", id: number | string): void;

  setPage(p: PageId): void;
  setRole(r: Role): void;
  setSearch(q: string): void;
  addToCart(p: Product, units?: number): void;
  setQty(productId: number, qty: number): void;
  removeLine(productId: number): void;
  clearCart(): void;
  setPatient(p: Patient | null): void;
  refreshProducts(): Promise<void>;
  holdOrder(): void;
  restoreHeld(): void;
  setQuickAdd(c: { barcode: string | null } | null): void;
  setIntakeOpen(v: boolean): void;
  newSale(): void;
  loadOperators(): Promise<void>;
  setOperator(name: string): void;
  setCurrentUser(u: AppUser | null): void;
  logout(): void;
  applySettings(s: Partial<{
    taxRate: number;
    pharmacyName: string;
    operator: string;
    receiptFooter: string;
    autoOperator: boolean;
    supportEmail: string;
    momoNumber: string;
    isDark: boolean;
    maxDiscountPct: number;
    setupComplete: boolean;
    tourSeen: boolean;
    fdaAutocomplete: boolean;
  }>): void;
  setTourOpen(v: boolean): void;
  /** FDA progress events land here (App-level listener, mounted once). */
  setFdaProgress(p: FdaProgress | null): void;
  /** Start the FDA catalog refresh unless one is already running. Resolves
   * with the drug count; the job (progress + result message) stays in the
   * store so tab switches can't lose it. */
  startFdaRefresh(): Promise<number>;
}

export const useStore = create<AppState>((set, get) => ({
  page: "dashboard",
  cart: [],
  patient: null,
  products: [],
  productsLoaded: false,
  taxRate: 0,
  pharmacyName: "Pulse Pharmacy",
  operator: "",
  receiptFooter: "",
  autoOperator: false,
  operators: [],
  supportEmail: "",
  momoNumber: "",
  isDark: false,
  maxDiscountPct: 100,
  setupComplete: false,
  tourSeen: false,
  fdaAutocomplete: true,
  tourOpen: false,
  heldCart: null,
  searchQuery: "",
  quickAdd: null,
  intakeOpen: false,
  currentUser: null,
  role: "mca",
  highlight: null,

  setPage: (page) => set({ page }),
  setHighlight: (highlight) => set({ highlight }),
  flash: (kind, id) => set({ highlight: { kind, id, n: Date.now() } }),
  setRole: (role) => set({ role }),
  setSearch: (q) => set({ searchQuery: q }),

  /** Add to the cart in sell units — `units` lets a pack/carton button add a
   * whole multiple at once. Stock is counted in sell units, so the cap is
   * always products.stock_qty. */
  addToCart: (p, units = 1) => {
    if (p.stock_qty <= 0) return;
    const add = Math.max(1, Math.floor(units));
    const cart = [...get().cart];
    const i = cart.findIndex((l) => l.productId === p.id);
    if (i >= 0) {
      cart[i] = { ...cart[i], qty: Math.min(cart[i].qty + add, p.stock_qty) };
    } else {
      cart.push({
        productId: p.id,
        name: p.name,
        unit: p.unit,
        unitPrice: p.selling_price,
        qty: Math.min(add, p.stock_qty),
      });
    }
    set({ cart });
  },

  setQty: (productId, qty) => {
    const stock = get().products.find((p) => p.id === productId)?.stock_qty;
    const cart = get().cart.map((l) =>
      l.productId === productId
        ? {
            ...l,
            // Clamp up to 1, and down to what's actually on the shelf.
            qty: Math.max(1, Math.min(Math.floor(qty), stock ?? Number.MAX_SAFE_INTEGER)),
          }
        : l,
    );
    set({ cart });
  },

  removeLine: (productId) =>
    set({ cart: get().cart.filter((l) => l.productId !== productId) }),

  clearCart: () => set({ cart: [] }),

  setPatient: (patient) => set({ patient }),

  refreshProducts: async () => {
    set({ products: await loadProducts(), productsLoaded: true });
  },

  holdOrder: () => {
    if (get().cart.length === 0) return;
    set({ heldCart: get().cart, cart: [] });
  },

  restoreHeld: () => {
    const h = get().heldCart;
    if (h) set({ cart: h, heldCart: null });
  },

  /** Start a fresh sale: hold any current order, clear the counter, go to POS. */
  newSale: () => {
    const st = get();
    if (st.cart.length > 0) st.holdOrder();
    set({ cart: [], patient: null, page: "pos", searchQuery: "" });
  },

  loadOperators: async () => {
    set({ operators: await dbLoadOperators() });
  },

  setOperator: (name) => {
    set({ operator: name });
    void saveSetting("operator", name);
  },

  setQuickAdd: (c) => set({ quickAdd: c }),
  setIntakeOpen: (v) => set({ intakeOpen: v }),
  setCurrentUser: (u) =>
    set({
      currentUser: u,
      role: u ? u.role : "mca",
      operator: u ? u.display_name : get().operator,
    }),
  logout: () => set({ currentUser: null, role: "mca" }),

  applySettings: (s) => set({ ...s }),
  setTourOpen: (v) => set({ tourOpen: v }),
  fdaJob: { status: "idle", progress: null, message: "" },
  setFdaProgress: (p) =>
    set((st) => ({
      fdaJob: st.fdaJob.status === "running" ? { ...st.fdaJob, progress: p } : st.fdaJob,
    })),
  startFdaRefresh: async () => {
    const st = get();
    if (st.fdaJob.status === "running") {
      throw new Error("Catalog update already running.");
    }
    set({ fdaJob: { status: "running", progress: null, message: "" } });
    try {
      const n = await refreshFdaCatalog(
        st.currentUser?.display_name ?? st.operator ?? null,
        st.currentUser?.role ?? null,
      );
      set({
        fdaJob: {
          status: "done",
          progress: null,
          message: `Updated — ${n.toLocaleString()} drugs. You can now type 2 letters in “Add Manual Item” to see matches.`,
        },
      });
      return n;
    } catch (e) {
      const message = String(e).replace(/^Error: /, "");
      set({ fdaJob: { status: "error", progress: null, message } });
      throw e;
    }
  },
}));

/** Owner and manager pass every manager gate (voids, backups, PIN changes,
 * user admin, expenses books). MCA passes money-movement gates only with a
 * manager-mode PIN session, and never the manager-only ones. */
export function isPrivileged(role: string | null | undefined): boolean {
  return role === "owner" || role === "manager";
}

/** Display label for the sidebar identity chip — the account's real role,
 * never a generic "cashier" tag. */
export function roleLabel(role: string | null | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "manager") return "Manager";
  return "MCA";
}
