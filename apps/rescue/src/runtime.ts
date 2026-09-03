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

/** True when the browser exposes real WebMCP. */
export const webmcpNative =
  typeof document !== "undefined" &&
  typeof (document as unknown as ModelContextHost).modelContext?.registerTool === "function";

/**
 * A runtime built the way the page builds its own, so a test can start one
 * on a mock model context and count what registers. The page's requires a
 * gesture token on approval; a test may relax that to `optional`.
 */
export function createRescueRuntime(
  options: { registerTool?: RegisterToolFn; approvalGesture?: "optional" | "required" } = {},
) {
  return createAgentDeskRuntime({
    capabilities: rescueCapabilities,
    ...(options.registerTool !== undefined || !webmcpNative
      ? { registerTool: options.registerTool ?? (async () => {}) }
      : {}),
    actor: { id: "agent", name: "Rescue Agent", kind: "agent" },
    // Bound once, here: the adapter forks, describes, and lands the rescue's
    // state, so a capability declares only its handler.
    staging: rescueAdapter,
    // An approval must carry a token minted on a click. The card's handler
    // mints one inside the click; nothing that only asserts an identity is
    // accepted by this instance.
    approvalGesture: options.approvalGesture ?? "required",
    // A plan approved against one state refuses to commit against another.
    revision: () => JSON.stringify(rows(getState())),
  });
}

/**
 * The runtime lives for the document. The page only observes its snapshot
 * and audit and answers approvals; it never calls a tool. An external
 * WebMCP client reaches the tools registered here, or, in the browser
 * without one, through `window.rescue.invoke` from the devtools console.
 */
export const rescue = createRescueRuntime();

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

/**
 * What the page exposes for inspection and for a client without WebMCP.
 * Minting is deliberately not on it: only the plan card's click handler
 * closes over `issueApprovalGesture`, so a script that reaches
 * `window.rescue` cannot mint a token.
 */
const { issueApprovalGesture: _mintOnlyFromTheCard, ...inspectable } = rescue;

declare global {
  interface Window {
    rescue: Omit<typeof rescue, "issueApprovalGesture">;
  }
}

if (typeof window !== "undefined") {
  window.rescue = inspectable;
}
