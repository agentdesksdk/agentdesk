import {
  createAgentDeskRuntime,
  type PersistenceAdapter,
  type RegisterToolFn,
  type Actor,
  type AppContext,
  type Exposure,
  type RuntimeSnapshot,
} from "@agentdesksdk/webmcp";
import { capabilities } from "../capabilities/index.ts";
import { stagingAdapter } from "../capabilities/staged.ts";
import { getState, resetStore } from "../data/store.ts";
import { createDemoPersistence } from "./persistence.ts";

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
/** The page's own store across reloads: IndexedDB in a browser, memory elsewhere. */
export const demoPersistence = createDemoPersistence();

/**
 * A runtime built the way the page builds its own, so a test can start two
 * on one persistence adapter and stand in for a reload.
 */
export function createMeridianRuntime(options: {
  persistence?: PersistenceAdapter;
  registerTool?: RegisterToolFn;
  approvalGesture?: "optional" | "required";
}) {
  return createAgentDeskRuntime({
    capabilities,
    registerTool: options.registerTool ?? (async () => {}),
    actor: { id: "agent", name: "Agent", kind: "agent" },
    staging: stagingAdapter,
    ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),
    ...(options.approvalGesture !== undefined ? { approvalGesture: options.approvalGesture } : {}),
  });
}

export const agentdesk = createAgentDeskRuntime({
  capabilities,
  ...(webmcpNative ? {} : { registerTool: async () => {} }),
  actor: { id: "agent", name: "Agent", kind: "agent" },
  // Bound once, here. A capability declares only its write, so the code that
  // describes a change and the code that performs it are not both supplied
  // by whoever declared the operation.
  staging: stagingAdapter,
  // An unknown outcome and a claimed idempotency key survive a reload.
  persistence: demoPersistence.adapter,
  // An approval must carry a token minted on a click. The card's handler
  // mints one inside the click; nothing that only asserts an identity is
  // accepted by this instance.
  approvalGesture: "required",
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

/**
 * Reset Demo. The runtime's own reset keeps unreconciled records on purpose,
 * and the persisted store is the page's, so a reset settles each open
 * record as the operator (the seed the store returns to holds none of it),
 * empties the persisted store, and only then resets the document and the
 * runtime. A record that cannot be settled is kept and named.
 */
export async function resetDemo(): Promise<{ settled: number; kept: string[] }> {
  const kept: string[] = [];
  let settled = 0;
  for (const record of agentdesk.listUnreconciled()) {
    const resolution =
      record.kind === "cleanup_failed"
        ? ({ kind: "cleanup_disposed" } as const)
        : ({ kind: "commit_not_applied" } as const);
    const outcome = agentdesk.reconcile(record.id, resolution, OPERATOR);
    if (outcome.ok) {
      settled += 1;
    } else {
      kept.push(`${record.id}: ${outcome.reason}`);
    }
  }
  await demoPersistence.adapter.clear();
  resetStore();
  await agentdesk.reset();
  return { settled, kept };
}

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

/**
 * What the page exposes for inspection. Minting is deliberately not on it:
 * a token proves a call made during a user activation by code with access
 * to the runtime, so only the approval card's click handler closes over
 * `issueApprovalGesture`, and a script that reaches `window.agentdesk`
 * cannot mint.
 */
const { issueApprovalGesture: _mintOnlyFromTheCard, ...inspectable } = agentdesk;

declare global {
  interface Window {
    agentdesk: Omit<typeof agentdesk, "issueApprovalGesture">;
  }
}

window.agentdesk = inspectable;
