import { create } from "zustand";
import type { CartLine, PageId, Patient, Product, Role } from "../types";
import { loadOperators as dbLoadOperators, loadProducts, saveSetting } from "../db";
import type { Operator } from "../db";

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
  heldCart: CartLine[] | null;
  searchQuery: string;
  quickAdd: { barcode: string | null } | null;
  intakeOpen: boolean;
  /** Manager vs cashier mode. Never persisted — a fresh launch starts as
   * cashier whenever a manager PIN is configured (App decides at boot). */
  role: Role;

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
  applySettings(s: Partial<{
    taxRate: number;
    pharmacyName: string;
    operator: string;
    receiptFooter: string;
    autoOperator: boolean;
    supportEmail: string;
    momoNumber: string;
    isDark: boolean;
    setupComplete: boolean;
  }>): void;
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
  setupComplete: false,
  heldCart: null,
  searchQuery: "",
  quickAdd: null,
  intakeOpen: false,
  role: "cashier",
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

  applySettings: (s) => set({ ...s }),
}));
