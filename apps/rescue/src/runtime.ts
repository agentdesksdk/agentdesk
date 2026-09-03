import {
  createAgentDeskRuntime,
  type Actor,
  type RegisterToolFn,
  type RuntimeSnapshot,
} from "@agentdesksdk/webmcp";
import { rescueAdapter } from "./adapter.ts";
import { rescueCapabilities } from "./capabilities.ts";
import { getState, reset, rows } from "./state.ts";

/** The person at the console. Approving is a human act, not the agent's. */
export const OPERATOR: Actor = { id: "operator", name: "Operator", kind: "human" };

type ModelContextHost = { modelContext?: { registerTool?: unknown } };

export const webmcpNative =
  typeof document !== "undefined" &&
  typeof (document as unknown as ModelContextHost).modelContext?.registerTool === "function";

/**
 * A runtime built the way the page builds its own, so a test can start one
 * on a mock model context and count what registers.
 */
export function createRescueRuntime(options: { registerTool?: RegisterToolFn } = {}) {
  return createAgentDeskRuntime({
    capabilities: rescueCapabilities,
    registerTool: options.registerTool ?? (async () => {}),
    actor: { id: "agent", name: "Rescue Agent", kind: "agent" },
    // Bound once, here: the adapter forks, describes, and lands the rescue's
    // state, so a capability declares only its handler.
    staging: rescueAdapter,
    // A plan approved against one state refuses to commit against another.
    revision: () => JSON.stringify(rows(getState())),
  });
}

export const rescue = webmcpNative
  ? createAgentDeskRuntime({
      capabilities: rescueCapabilities,
      actor: { id: "agent", name: "Rescue Agent", kind: "agent" },
      staging: rescueAdapter,
      revision: () => JSON.stringify(rows(getState())),
    })
  : createRescueRuntime();

void rescue.start();

let cached: RuntimeSnapshot = rescue.getSnapshot();
rescue.subscribe((snapshot) => {
  cached = snapshot;
});

export function subscribeRuntime(callback: () => void): () => void {
  return rescue.subscribe(() => callback());
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return cached;
}

/** Reset: the seed comes back, and the runtime forgets its plans and receipts. */
export async function resetRescue(): Promise<void> {
  reset();
  await rescue.reset();
}

declare global {
  interface Window {
    rescue: typeof rescue;
  }
}

if (typeof window !== "undefined") {
  window.rescue = rescue;
}
