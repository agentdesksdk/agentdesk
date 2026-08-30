import { deepFreeze } from "./audit.ts";
import type { CapabilityName } from "./capability.ts";
import type { Actor, HumanActor, VerificationResult } from "./plan.ts";
import type { Receipt } from "./results.ts";

/**
 * READY is undoable, ROLLING_BACK is claimed by an in-flight rollback,
 * ROLLED_BACK is spent.
 *
 * INDETERMINATE is what a dispatched compensating action leaves behind when
 * it throws. An exception proves the handler did not return, never that it
 * did not write, so returning to READY would invite a second compensating
 * write on top of one that may already have landed.
 *
 * Nothing the runtime can observe settles that. An execution verifier
 * answers whether the original write is still visible, which is a different
 * question from whether the compensation ran, and the two only coincide when
 * the compensation is the exact inverse of the write. A compensation that is
 * itself a forward transaction leaves the original state visible, so
 * inferring "safe to retry" from a verifier is how a double refund happens.
 *
 * Only `ReceiptStore.reconcile` leaves this state, and it takes the answer
 * from a caller who went and looked.
 */
export type RollbackState =
  | "READY"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "INDETERMINATE";

/** What a human or an application established about an unreconciled rollback. */
export type ReconciliationOutcome = "compensated" | "untouched";

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
   * How well the rollback was proven, alongside `verification` for the
   * execution. UNSUPPORTED means the capability declared no verifier, so
   * success here rests on the handler's word and nothing else.
   */
  rollbackVerification?: VerificationResult;
  /** When a compensating action was dispatched and then failed. */
  rollbackAttemptedAt?: number;
  /** Why it failed, kept so an operator reconciling later can see it. */
  rollbackFailure?: string;
  /** Who established what an indeterminate rollback actually did. */
  reconciledAt?: number;
  reconciledBy?: Actor;
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

  /**
   * Returns a rollback to READY. Only for a refusal that happened before the
   * handler was dispatched, where nothing can have run.
   */
  releaseRollback(id: string): void {
    this.moveRollback(id, "ROLLING_BACK", "READY");
  }

  /** Parks a dispatched rollback whose compensating action may have landed. */
  markIndeterminate(id: string, at: number, failure: string): void {
    this.moveRollback(id, "ROLLING_BACK", "INDETERMINATE", {
      rollbackAttemptedAt: at,
      rollbackFailure: failure,
    });
  }

  markRolledBack(
    id: string,
    at: number,
    rollbackVerification: VerificationResult,
  ): void {
    this.moveRollback(id, "ROLLING_BACK", "ROLLED_BACK", {
      rolledBackAt: at,
      rollbackVerification,
    });
  }

  /**
   * The only exit from INDETERMINATE. `compensated` means someone confirmed
   * the compensating write landed, so the receipt is spent. `untouched` means
   * they confirmed it did not, so undo is safe to attempt again.
   */
  reconcile(
    id: string,
    outcome: ReconciliationOutcome,
    at: number,
    by?: Actor,
  ): boolean {
    return this.moveRollback(
      id,
      "INDETERMINATE",
      outcome === "compensated" ? "ROLLED_BACK" : "READY",
      {
        reconciledAt: at,
        ...(by ? { reconciledBy: structuredClone(by) } : {}),
        ...(outcome === "compensated" ? { rolledBackAt: at } : {}),
      },
    );
  }

  private moveRollback(
    id: string,
    from: RollbackState,
    to: RollbackState,
    fields?: Partial<StoredReceipt>,
  ): boolean {
    const index = this.receipts.findIndex((entry) => entry.id === id);
    const existing = this.receipts[index];
    if (!existing || existing.rollbackState !== from) {
      return false;
    }
    this.receipts[index] = deepFreeze({
      ...existing,
      rollbackState: to,
      ...fields,
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
