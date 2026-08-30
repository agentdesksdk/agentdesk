import { deepFreeze } from "./audit.ts";
import type { CapabilityName } from "./capability.ts";
import type { Actor, HumanActor, VerificationResult } from "./plan.ts";
import type { Receipt } from "./results.ts";

/**
 * READY is undoable, ROLLING_BACK is claimed by an in-flight rollback,
 * ROLLED_BACK is spent. A failed compensating action returns to READY,
 * because a rollback that could not run is a retry, not a dead end.
 */
export type RollbackState = "READY" | "ROLLING_BACK" | "ROLLED_BACK";

export type StoredReceipt = {
  id: string;
  capability: CapabilityName;
  executionId: string;
  planId?: string;
  /** Who ran the capability, captured at execution. */
  executedBy?: Actor;
  /** The input the capability ran with, so a rollback can address the same entity. */
  input: Record<string, unknown>;
  receipt: Receipt;
  verification: VerificationResult;
  at: number;
  rollbackState: RollbackState;
  /** Set once a rollback has been performed against this receipt. */
  rolledBackAt?: number;
  /**
   * Review state sits beside the receipt, never inside it. Marking
   * something reviewed does not change what occurred.
   */
  reviewedAt?: number;
  reviewedBy?: HumanActor;
};

export type ReceiptQuery = {
  capability?: string;
  planId?: string;
  /** Matches `executedBy.id`, the actor that ran the capability. */
  actorId?: string;
  since?: number;
  limit?: number;
  reviewed?: boolean;
};

/**
 * Queryable history of what actually changed, distinct from the audit log.
 * Audit records that things happened; this records what they did, with the
 * evidence attached, so "show me every refund this agent made" is one call
 * rather than a scan.
 *
 * In-memory and bounded, like the rest of the runtime's state. Durable
 * storage is an application concern; use `subscribeAudit` or export these
 * to persist them.
 */
export class ReceiptStore {
  private receipts: StoredReceipt[] = [];
  private nextId = 1;

  constructor(private readonly limit = 500) {}

  record(entry: Omit<StoredReceipt, "id" | "rollbackState">): StoredReceipt {
    const stored: StoredReceipt = {
      ...structuredClone(entry),
      id: `RCPT-${this.nextId++}`,
      rollbackState: "READY",
    };
    deepFreeze(stored);
    this.receipts.push(stored);
    if (this.receipts.length > this.limit) {
      this.receipts.splice(0, this.receipts.length - this.limit);
    }
    return stored;
  }

  get(id: string): StoredReceipt | undefined {
    return this.receipts.find((entry) => entry.id === id);
  }

  /**
   * The atomic claim a rollback runs under, the receipt-side twin of
   * `PlanStore.transition`. Callers must win this synchronously, before
   * their first await, or two concurrent undos both reach the handler.
   */
  claimRollback(id: string): boolean {
    return this.moveRollback(id, "READY", "ROLLING_BACK");
  }

  /** Returns a failed rollback to READY so the caller can retry it. */
  releaseRollback(id: string): void {
    this.moveRollback(id, "ROLLING_BACK", "READY");
  }

  markRolledBack(id: string, at: number): void {
    this.moveRollback(id, "ROLLING_BACK", "ROLLED_BACK", at);
  }

  private moveRollback(
    id: string,
    from: RollbackState,
    to: RollbackState,
    rolledBackAt?: number,
  ): boolean {
    const index = this.receipts.findIndex((entry) => entry.id === id);
    const existing = this.receipts[index];
    if (!existing || existing.rollbackState !== from) {
      return false;
    }
    this.receipts[index] = deepFreeze({
      ...existing,
      rollbackState: to,
      ...(rolledBackAt !== undefined ? { rolledBackAt } : {}),
    });
    return true;
  }

  markReviewed(id: string, at: number, by?: HumanActor): void {
    const index = this.receipts.findIndex((entry) => entry.id === id);
    const existing = this.receipts[index];
    if (existing) {
      this.receipts[index] = deepFreeze({
        ...existing,
        reviewedAt: at,
        ...(by !== undefined ? { reviewedBy: structuredClone(by) } : {}),
      });
    }
  }

  query(filter: ReceiptQuery = {}): StoredReceipt[] {
    const matched = this.receipts.filter(
      (entry) =>
        (filter.capability === undefined ||
          entry.capability === filter.capability) &&
        (filter.planId === undefined || entry.planId === filter.planId) &&
        (filter.actorId === undefined ||
          entry.executedBy?.id === filter.actorId) &&
        (filter.since === undefined || entry.at >= filter.since) &&
        (filter.reviewed === undefined ||
          (entry.reviewedAt !== undefined) === filter.reviewed),
    );
    const newestFirst = matched.reverse();
    return filter.limit === undefined
      ? newestFirst
      : newestFirst.slice(0, filter.limit);
  }

  clear(): void {
    this.receipts = [];
  }
}
