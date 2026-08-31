import type { RiskLevel } from "./capability.ts";
import type { Actor, HumanActor } from "./plan.ts";
import type { Receipt } from "./results.ts";

export type AuditEvent =
  | { kind: "context_changed"; route: string; exposure: string; at: number }
  | {
      kind: "capability_routed";
      query: string;
      matched: string[];
      activated: string[];
      catalogSize: number;
      at: number;
    }
  | { kind: "tool_registered"; tool: string; at: number }
  | { kind: "tool_retired"; tool: string; at: number }
  | {
      kind: "capability_invoked";
      capability: string;
      risk: RiskLevel;
      via: "native" | "invoke";
      at: number;
    }
  | {
      kind: "capability_unavailable";
      capability: string;
      reasonCode: string;
      at: number;
    }
  | {
      kind: "policy_denied";
      capability: string;
      reason: string;
      at: number;
    }
  | {
      kind: "approval_requested";
      capability: string;
      actionId: string;
      risk: RiskLevel;
      summary: string;
      at: number;
    }
  | {
      kind: "approval_approved";
      actionId: string;
      capability: string;
      /** The human who authorized it. An agent cannot stand in for one. */
      approvedBy?: Actor;
      at: number;
    }
  | {
      kind: "approval_rejected";
      actionId: string;
      capability: string;
      /** The human who refused it. */
      rejectedBy?: Actor;
      at: number;
    }
  | {
      kind: "execution_started";
      capability: string;
      executionId: string;
      actor?: Actor;
      at: number;
    }
  | {
      kind: "execution_completed";
      capability: string;
      executionId: string;
      receipt?: Receipt;
      actor?: Actor;
      at: number;
    }
  | {
      kind: "execution_failed";
      capability: string;
      executionId: string;
      error: string;
      actor?: Actor;
      at: number;
    }
  | {
      kind: "plan_prepared";
      planId: string;
      operations: string[];
      risk: RiskLevel;
      at: number;
    }
  | { kind: "plan_approved"; planId: string; actor: HumanActor; at: number }
  | { kind: "plan_rejected"; planId: string; at: number }
  | {
      kind: "plan_drifted";
      planId: string;
      expectedRevision: string;
      observedRevision: string;
      at: number;
    }
  | {
      kind: "plan_committed";
      planId: string;
      outcomes: Array<{
        capability: string;
        status: string;
        verification: string;
      }>;
      at: number;
    }
  | {
      kind: "plan_partial";
      planId: string;
      outcomes: Array<{
        capability: string;
        status: string;
        verification: string;
      }>;
      at: number;
    }
  | {
      kind: "plan_failed";
      planId: string;
      outcomes: Array<{
        capability: string;
        status: string;
        verification: string;
      }>;
      at: number;
    }
  | {
      kind: "rollback_performed";
      capability: string;
      receiptId: string;
      actor?: Actor;
      at: number;
    }
  | {
      kind: "staged_reconciled";
      capability: string;
      recordId: string;
      outcome: "applied" | "not_applied";
      actor: Actor;
      at: number;
    }
  | {
      kind: "staged_cleanup_failed";
      capability: string;
      recordId: string;
      detail: string;
      at: number;
    }
  | {
      kind: "execution_indeterminate";
      capability: string;
      executionId: string;
      recordId: string;
      detail: string;
      actor?: Actor;
      at: number;
    }
  | {
      kind: "rollback_indeterminate";
      capability: string;
      receiptId: string;
      at: number;
    }
  | {
      kind: "rollback_reconciled";
      capability: string;
      receiptId: string;
      outcome: "compensated" | "untouched";
      /** The human who checked. Required, because the claim is theirs. */
      actor: HumanActor;
      at: number;
    }
  | {
      kind: "receipt_reviewed";
      capability: string;
      receiptId: string;
      actor: HumanActor;
      at: number;
    };

const MAX_EVENTS = 1000;

export type AuditListener = (event: AuditEvent) => void;

export class AuditBus {
  private events: AuditEvent[] = [];
  private readonly listeners = new Set<AuditListener>();

  subscribe(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * History is evidence, so the stored event is detached from the caller's
   * object and deep-frozen, nested receipts included. Freezing once on
   * write beats cloning on every read: `list()` runs on every snapshot,
   * and cloning a thousand events per emit made execution quadratic.
   */
  append(event: AuditEvent): void {
    const stored = deepFreeze(structuredClone(event));
    this.events.push(stored);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch (err) {
        console.error("agentdesk audit listener threw", err);
      }
    }
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export function now(): number {
  return Date.now();
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}
