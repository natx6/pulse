import { create } from "zustand";
import type { CartLine, PageId, Patient, Product } from "../types";
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
  heldCart: CartLine[] | null;
  searchQuery: string;
  quickAdd: { barcode: string | null } | null;
  intakeOpen: boolean;

  setPage(p: PageId): void;
  setSearch(q: string): void;
  addToCart(p: Product): void;
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
  }>): void;
}

export const useStore = create<AppState>((set, get) => ({
  page: "pos",
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
  heldCart: null,
  searchQuery: "",
  quickAdd: null,
  intakeOpen: false,

  setPage: (page) => set({ page }),
  setSearch: (q) => set({ searchQuery: q }),

  addToCart: (p) => {
    if (p.stock_qty <= 0) return;
    const cart = [...get().cart];
    const i = cart.findIndex((l) => l.productId === p.id);
    if (i >= 0) {
      const cap = Math.max(p.stock_qty, cart[i].qty);
      cart[i] = { ...cart[i], qty: Math.min(cart[i].qty + 1, cap) };
    } else {
      cart.push({
        productId: p.id,
        name: p.name,
        unit: p.unit,
        unitPrice: p.selling_price,
        qty: 1,
      });
    }
    set({ cart });
  },

  setQty: (productId, qty) => {
    const cart = get().cart.map((l) =>
      l.productId === productId ? { ...l, qty: Math.max(1, Math.floor(qty)) } : l,
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
