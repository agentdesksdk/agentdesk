import {
  createAgentDeskRuntime,
  type Actor,
  type AppContext,
  type Exposure,
  type RuntimeSnapshot,
} from "@agentdesk/webmcp";
import { capabilities } from "../capabilities/index.ts";
import { getState, stagingScope } from "../data/store.ts";

type ModelContextHost = { modelContext?: { registerTool?: unknown } };

/**
 * The person at the keyboard. A real deployment reads this from the session.
 * Approving, rejecting, and reviewing all have to be signed by a human rather
 * than by the agent whose work is being authorized, so every surface uses
 * this one identity instead of keeping its own copy.
 */
export const OPERATOR: Actor = { id: "operator", name: "Operator", kind: "human" };

/** True when the browser exposes real WebMCP. */
export const webmcpNative =
  typeof (document as unknown as ModelContextHost).modelContext?.registerTool ===
  "function";

/**
 * The runtime lives for the document, not for any React component.
 * React only observes snapshots; registration lifecycle stays in the SDK.
 * Without native WebMCP we register into an in-page no-op sink so the
 * surface, counts, and schema bytes remain observable; the UI labels this
 * state "simulated".
 */
export const agentdesk = createAgentDeskRuntime({
  capabilities,
  ...(webmcpNative ? {} : { registerTool: async () => {} }),
  actor: { id: "agent", name: "Agent", kind: "agent" },
  // Plan preparation derives every operation inside one branch, so the
  // second operation previews against what the first one staged.
  stagingScope,
  // Cheap revision over the mutable parts of the store. A plan approved
  // against one revision refuses to commit against another.
  revision: () => {
    const state = getState();
    return [
      state.orders
        .map((o) => `${o.id}:${o.status}:${o.shippingRefunded}`)
        .join("|"),
      state.credits.length,
      state.invoices.map((i) => `${i.id}:${i.status}`).join("|"),
    ].join("#");
  },
  describeContext: (ctx) => {
    const out: Record<string, unknown> = { ...ctx.state };
    const state = getState();
    if (typeof ctx.state.customerId === "string") {
      const customer = state.customers.find((c) => c.id === ctx.state.customerId);
      if (customer) {
        out.customer = { id: customer.id, name: customer.name };
      }
    }
    if (typeof ctx.state.orderId === "string") {
      const order = state.orders.find((o) => o.id === ctx.state.orderId);
      if (order) {
        out.order = {
          id: order.id,
          status: order.status,
          shipping_paid: order.shippingPaid,
          shipping_refunded: order.shippingRefunded,
        };
      }
    }
    return out;
  },
});

void agentdesk.start();

let cached: RuntimeSnapshot = agentdesk.getSnapshot();
agentdesk.subscribe((snapshot) => {
  cached = snapshot;
});

export function subscribeRuntime(callback: () => void): () => void {
  return agentdesk.subscribe(() => callback());
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return cached;
}

export function contextForPath(pathname: string): {
  exposure: Exposure;
  context: AppContext;
} {
  const [, mode = "agentdesk", ...rest] = pathname.split("/");
  const route = `/${rest.join("/")}`;
  const state: Record<string, unknown> = {};
  const [section, id] = rest;
  if (section) {
    state.domain = section;
  }
  if (section === "customers" && id) {
    state.customerId = id;
  }
  if (section === "orders" && id) {
    state.orderId = id;
  }
  if (section === "support" && id) {
    state.ticketId = id;
  }
  return {
    exposure: mode === "baseline" ? "flat" : "routed",
    context: { route, state },
  };
}

declare global {
  interface Window {
    agentdesk: typeof agentdesk;
  }
}

window.agentdesk = agentdesk;
