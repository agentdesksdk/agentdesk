import { deepFreeze } from "./audit.ts";
import type { CapabilityName } from "./capability.ts";
import type { Actor, VerificationResult } from "./plan.ts";
import type { Receipt } from "./results.ts";

export type StoredReceipt = {
  id: string;
  capability: CapabilityName;
  executionId: string;
  planId?: string;
  actor?: Actor;
  /** The input the capability ran with, so a rollback can address the same entity. */
  input: Record<string, unknown>;
  receipt: Receipt;
  verification: VerificationResult;
  at: number;
  /** Set once a rollback has been performed against this receipt. */
  rolledBackAt?: number;
  /**
   * Review state sits beside the receipt, never inside it. Marking
   * something reviewed does not change what occurred.
   */
  reviewedAt?: number;
  reviewedBy?: Actor;
};

export type ReceiptQuery = {
  capability?: string;
  planId?: string;
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

  record(entry: Omit<StoredReceipt, "id">): StoredReceipt {
    const stored: StoredReceipt = {
      ...structuredClone(entry),
      id: `RCPT-${this.nextId++}`,
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

  markRolledBack(id: string, at: number): void {
    const index = this.receipts.findIndex((entry) => entry.id === id);
    const existing = this.receipts[index];
    if (existing) {
      this.receipts[index] = Object.freeze({ ...existing, rolledBackAt: at });
    }
  }

  markReviewed(id: string, at: number, by?: Actor): void {
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
        (filter.actorId === undefined || entry.actor?.id === filter.actorId) &&
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
