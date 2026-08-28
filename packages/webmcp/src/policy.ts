import type { AppContext, Capability } from "./capability.ts";

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "require_approval"; reason?: string }
  | { kind: "deny"; reason: string };

export type PolicyRequest = {
  capability: Capability;
  input: Record<string, unknown>;
  context: AppContext;
};

export type PolicyEngine = (request: PolicyRequest) => PolicyDecision;

/**
 * READ and WRITE execute (WRITE additionally audits); CONSEQUENTIAL
 * requires human approval. An explicit per-capability policy overrides the
 * risk-derived default (defineCapability resolves that).
 *
 * Replace wholesale via `createAgentDeskRuntime({ policy })` to add limits
 * ("refund <= $500"), deny rules, or tenant-specific decisions. Custom
 * engines can call this for the default and override selectively.
 */
export const riskBasedPolicy: PolicyEngine = ({ capability }) =>
  capability.policy.kind === "approval_required"
    ? { kind: "require_approval" }
    : { kind: "allow" };

/** Back-compat shorthand used internally and by existing callers. */
export function decidePolicy(
  capability: Capability,
): "allow" | "approval_required" {
  return capability.policy.kind === "approval_required"
    ? "approval_required"
    : "allow";
}
