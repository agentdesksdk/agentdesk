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
  status: "COMPLETED" | "SKIPPED" | "FAILED";
  detail?: string;
  verification: VerificationResult;
};

/**
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
  approvedBy?: Actor;
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
