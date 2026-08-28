import type { Capability } from "./capability.ts";

export type PolicyDecision = "allow" | "approval_required";

/**
 * READ and WRITE execute (WRITE additionally audits); CONSEQUENTIAL
 * requires human approval. An explicit per-capability policy overrides
 * the risk-derived default (defineCapability resolves that).
 */
export function decidePolicy(capability: Capability): PolicyDecision {
  return capability.policy.kind === "approval_required"
    ? "approval_required"
    : "allow";
}
