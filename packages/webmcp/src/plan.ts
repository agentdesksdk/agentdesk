import type { CapabilityName, Change, RiskLevel } from "./capability.ts";

export type PlanId = string & { readonly __brand: "PlanId" };

/**
 * Who is acting. Recorded on receipts, on presentation events, and on the
 * execution audit events, so "who changed this" is answerable after the
 * fact. It is not on every audit event. Deliberately not an
 * authentication claim. The application asserts it, the runtime records
 * it.
 */
export type Actor = {
  id: string;
  name?: string;
  kind: "agent" | "human" | "system";
};

/**
 * An actor the runtime has checked is a person. The events that exist to
 * record a human decision carry this rather than an optional `Actor`, so a
 * consumer reading `plan_approved` or `receipt_reviewed` gets the guarantee
 * from the type instead of a cast.
 */
export type HumanActor = Actor & { kind: "human" };

const ACTOR_KINDS = ["agent", "human", "system"] as const;

function isActorKind(value: string): value is Actor["kind"] {
  return ACTOR_KINDS.some((kind) => kind === value);
}

/**
 * The published SDK is callable from JavaScript, so an `Actor` annotation on
 * a public parameter proves nothing about what actually arrives. Every
 * identity the runtime records passes through here first.
 *
 * The returned actor is rebuilt from the fields that were checked, so an
 * extra property on the caller's object cannot ride along into a plan, a
 * receipt, or the audit stream.
 */
export function parseActor(
  value: unknown,
): { ok: true; actor: Actor } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      reason: `an identity must be an object, received ${value === null ? "null" : typeof value}`,
    };
  }
  const id: unknown = "id" in value ? value.id : undefined;
  const kind: unknown = "kind" in value ? value.kind : undefined;
  const name: unknown = "name" in value ? value.name : undefined;

  if (typeof id !== "string") {
    return {
      ok: false,
      reason: `an identity must carry a string id, received ${id === null ? "null" : typeof id}`,
    };
  }
  if (id.trim() === "") {
    return { ok: false, reason: "an identity id must not be empty or blank" };
  }
  if (typeof kind !== "string" || !isActorKind(kind)) {
    return {
      ok: false,
      reason: `an identity kind must be one of ${ACTOR_KINDS.join(", ")}, received ${JSON.stringify(kind)}`,
    };
  }
  if (name !== undefined && typeof name !== "string") {
    return {
      ok: false,
      reason: `an identity name must be a string when present, received ${typeof name}`,
    };
  }
  return {
    ok: true,
    actor: { id, kind, ...(name !== undefined ? { name } : {}) },
  };
}

/**
 * Give this the actor from `parseActor`, never a caller's object. The
 * `kind` check is only a guarantee about a value whose shape has already
 * been established.
 */
export function isHumanActor(actor: Actor): actor is HumanActor {
  return actor.kind === "human";
}

export type PlannedOperation = {
  capability: CapabilityName;
  input: Record<string, unknown>;
  preview: Change[];
};

/**
 * Did the application actually end up in the state the plan promised?
 * Produced by reading state back after execution, not by trusting the
 * handler's own report.
 */
export type VerificationResult =
  | { status: "VERIFIED" }
  | { status: "PARTIAL"; unverified: string[]; note?: string }
  | { status: "MISMATCH"; field: string; expected: unknown; observed: unknown }
  | { status: "UNSUPPORTED" };

export type OperationOutcome = {
  capability: CapabilityName;
  executionId?: string;
  /**
   * INDETERMINATE means the commit threw after it may already have written.
   * It is not FAILED, because calling it that invites the retry that would
   * apply the change twice.
   */
  status: "COMPLETED" | "SKIPPED" | "FAILED" | "INDETERMINATE";
  /** The reconciliation record, when the outcome is INDETERMINATE. */
  recordId?: string;
  detail?: string;
  verification: VerificationResult;
};

/**
 * INTERRUPTED means stop() or reset() ended the session while the plan was
 * committing. It is terminal for that session and says the plan neither
 * finished nor failed, which is the only honest thing to record about work
 * the runtime stopped watching.
 *
 * COMMITTED means every operation ran and nothing was disproved.
 * PARTIAL means the plan reached the end without failing and without
 * earning that claim, because an operation was skipped or a verifier
 * returned MISMATCH.
 */
export type PlanStatus =
  | "DRAFT"
  | "APPROVED"
  | "COMMITTING"
  | "COMMITTED"
  | "PARTIAL"
  | "INTERRUPTED"
  /**
   * An operation's result became unknown, so the plan stopped rather than
   * building later operations on a change nobody can confirm.
   */
  | "INDETERMINATE"
  | "REJECTED"
  | "DRIFTED"
  | "FAILED";

export type OperationPlan = {
  id: PlanId;
  operations: PlannedOperation[];
  summary: string;
  /** Highest risk across the operations. */
  risk: RiskLevel;
  /**
   * The application revision the plan was built against. Compared again at
   * commit; a change means the human reviewed a plan that no longer
   * describes reality.
   */
  expectedRevision?: string;
  /** Who asked for the plan, captured at `prepare`. */
  requestedBy?: Actor;
  /** Who authorized it, captured at `approvePlan`. */
  approvedBy?: HumanActor;
  createdAt: number;
  status: PlanStatus;
  /** Present once the plan reaches a terminal state. */
  outcomes?: OperationOutcome[];
  observedRevision?: string;
  resolvedAt?: number;
};

const RISK_ORDER: RiskLevel[] = ["READ", "WRITE", "CONSEQUENTIAL"];

export function highestRisk(risks: readonly RiskLevel[]): RiskLevel {
  return risks.reduce<RiskLevel>(
    (worst, risk) =>
      RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst) ? risk : worst,
    "READ",
  );
}

export class PlanStore {
  private nextId = 1;
  private readonly plans = new Map<string, OperationPlan>();

  create(plan: Omit<OperationPlan, "id" | "status">): OperationPlan {
    const id = `PLAN-${this.nextId++}` as PlanId;
    const stored: OperationPlan = {
      ...structuredClone(plan),
      id,
      status: "DRAFT",
    };
    this.plans.set(id, stored);
    return structuredClone(stored);
  }

  get(id: string): OperationPlan | undefined {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  /** Detached copies; a UI must not be able to edit a reviewed plan. */
  list(): OperationPlan[] {
    return [...this.plans.values()].map((plan) => structuredClone(plan));
  }

  /**
   * Atomically moves a plan between statuses. Returns the plan only to the
   * caller that won, so a double commit cannot execute twice.
   */
  transition(
    id: string,
    from: PlanStatus,
    to: PlanStatus,
  ): OperationPlan | undefined {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== from) {
      return undefined;
    }
    plan.status = to;
    return structuredClone(plan);
  }

  resolve(id: string, patch: Partial<OperationPlan>): void {
    const plan = this.plans.get(id);
    if (plan) {
      Object.assign(plan, structuredClone(patch));
    }
  }

  clear(): void {
    this.plans.clear();
  }
}
