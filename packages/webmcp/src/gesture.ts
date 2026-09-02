import type { HumanActor } from "./plan.ts";

/**
 * A human gesture, as something the runtime can verify rather than an
 * assertion it has to take on trust.
 *
 * A page token is issued by the runtime on a human click, through an API
 * only page code can reach, and is verified and consumed at approve time.
 * WebAuthn is the stronger option behind the same seam: a second member of
 * this union carrying an assertion, verified by a second verifier, with no
 * change to `approve` or `approvePlan` or their callers.
 */
export type ApprovalGesture = {
  kind: "page-token";
  id: string;
  secret: string;
};

/** What a token is issued for. One token approves one thing. */
export type GestureBinding = { actionId: string } | { planId: string };

export type GestureVerdict =
  | { ok: true; id: string; by: HumanActor }
  | { ok: false; reason: string };

export function isApprovalGesture(value: unknown): value is ApprovalGesture {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "page-token" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}
