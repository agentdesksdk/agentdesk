import type { Change } from "./capability.ts";

/**
 * The result protocol. Every terminal result the runtime hands an agent
 * answers five questions: what changed, what is now possible, what stays
 * blocked, which capability repairs the situation, and what evidence proves
 * the answer.
 *
 * The answers are one type here so they cannot drift between results, and
 * the variants are spelled out so the combinations that cannot happen are
 * not constructible. A success carries `changes` and never a `repair`. A
 * refusal carries a `reason` and may carry a `repair`, and never `changes`.
 */

/** The capability that repairs a refusal, with the input to call it with. */
export type Repair = {
  capability: string;
  input?: Record<string, unknown>;
};

/** A runtime-issued id that proves an answer. */
export type Evidence =
  | { kind: "receipt"; id: string }
  | { kind: "execution"; id: string }
  | { kind: "approval"; id: string }
  | { kind: "record"; id: string };

/**
 * What the agent can do next, computed by the runtime from the same
 * eligibility routing uses. A capability policy denies is in neither list,
 * so neither list can name something the agent could not route to.
 */
export type Situation = {
  readonly nowPossible: readonly string[];
  readonly blockedCapabilities: readonly string[];
  readonly evidence: readonly Evidence[];
};

/** What a refusal is built from. It may name the capability that repairs it. */
export type Refusal = Situation & { readonly repair?: Repair };

/**
 * What a completed, pending, or indeterminate result is built from. The
 * `never` is what stops a refusal's situation from being handed to a
 * success builder.
 */
export type Settled = Situation & { readonly repair?: never };

export type RefusalStatus =
  | "TOOL_RETIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_CAPACITY"
  | "PREVIEW_UNAVAILABLE"
  | "EXECUTION_CANCELLED"
  | "GRANT_REFUSED";

/** The shape on the wire, discriminated by the `status` every payload carries. */
export type ResultProtocol =
  | (Situation & {
      status: "COMPLETED";
      changes: readonly Change[];
      reason?: never;
      repair?: never;
    })
  | (Situation & {
      status: "APPROVAL_REQUIRED";
      changes?: never;
      reason?: never;
      repair?: never;
    })
  | (Situation & {
      /** A write whose outcome nobody can establish: what may have changed. */
      status: "INDETERMINATE";
      changes: readonly Change[];
      reason?: never;
      repair?: never;
    })
  | (Situation & {
      status: RefusalStatus;
      reason: string;
      repair?: Repair;
      changes?: never;
    });
