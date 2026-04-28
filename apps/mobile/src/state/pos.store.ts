import { create } from 'zustand';

export type CartLine = {
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
};

export type Session = {
  id: string;
  userId: string;
  openingBalanceCents: number;
  status: 'open' | 'closing' | 'closed';
};

type PosState = {
  session: Session | null;
  cart: CartLine[];
  buyerTin: string;
  setSession(s: Session | null): void;
  add(p: { id: string; name: string; priceCents: number }): void;
  inc(productId: string, delta: number): void;
  remove(productId: string): void;
  clear(): void;
  setBuyerTin(tin: string): void;
};

export const usePos = create<PosState>((set) => ({
  session: null,
  cart: [],
  buyerTin: '',
  setSession: (session) => set({ session }),
  add: (p) =>
    set((s) => {
      const i = s.cart.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        const next = [...s.cart];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return { cart: next };
      }
      return { cart: [...s.cart, { productId: p.id, name: p.name, qty: 1, unitPriceCents: p.priceCents }] };
    }),
  inc: (productId, delta) =>
    set((s) => ({
      cart: s.cart
        .map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    })),
  remove: (productId) => set((s) => ({ cart: s.cart.filter((l) => l.productId !== productId) })),
  clear: () => set({ cart: [], buyerTin: '' }),
  setBuyerTin: (tin) => set({ buyerTin: tin.replace(/\D/g, '').slice(0, 13) }),
}));
