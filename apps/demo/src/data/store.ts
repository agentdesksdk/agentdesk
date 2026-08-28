import { buildSeed } from "./seed.ts";
import type { DemoState } from "./types.ts";

type Listener = () => void;

let state: DemoState = buildSeed();
const listeners = new Set<Listener>();

export function getState(): DemoState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mutate(fn: (draft: DemoState) => void): void {
  const next: DemoState = {
    customers: state.customers.map((c) => ({ ...c, tags: [...c.tags], notes: [...c.notes] })),
    orders: state.orders.map((o) => ({
      ...o,
      items: o.items.map((item) => ({ ...item })),
      notes: [...o.notes],
      tags: [...o.tags],
    })),
    products: state.products.map((p) => ({ ...p })),
    tickets: state.tickets.map((t) => ({
      ...t,
      messages: t.messages.map((m) => ({ ...m })),
    })),
    credits: state.credits.map((c) => ({ ...c })),
    invoices: state.invoices.map((i) => ({ ...i })),
  };
  fn(next);
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function resetStore(): void {
  state = buildSeed();
  for (const listener of listeners) {
    listener();
  }
}
