import type { Change } from "./capability.ts";
import type { Actor } from "./plan.ts";

/**
 * Durability. What a restart must not lose, and the seam an application
 * supplies to keep it.
 *
 * The accepted-risk record of 2026-08-31 names the losses: the unreconciled
 * record with its `operationKey`, so the repeat guard survives; the approved
 * changes and the ids that bind the record to an approval or a plan, so a
 * person can still find and close it; and the adapter's artifact, held by
 * identity, so `reconcile` still has something to hand back. The shapes
 * below carry all of it, and nothing here is inspected by the runtime beyond
 * checking that what comes back is what went in.
 */

/**
 * How the staging adapter's artifact was kept.
 *
 * `value` is the artifact itself, when `structuredClone` could take it.
 * `reference` is what the staging adapter's `identify` returned for an
 * artifact that could not be cloned: a durable key the application can
 * rebuild from. `lost` is an artifact that was neither cloneable nor
 * identified; the record still surfaces and still guards, and only a
 * `resolveArtifact` that can rebuild from the record alone can close it.
 */
export type PersistedArtifact =
  | { kind: "value"; value: unknown }
  | { kind: "reference"; reference: unknown }
  | { kind: "lost" };

/**
 * Everything the accepted-risk record lists as lost, plus the actor, the
 * state digest, and the grant that authorized the write, plus a seal.
 * The seal is a digest of the evidence fields computed at save; a record
 * whose seal does not match at load is refused rather than trusted.
 */
export type PersistedRecord = {
  version: 1;
  id: string;
  kind: "commit_indeterminate" | "cleanup_failed";
  capability: string;
  detail: string;
  /** What the person approved, kept as the thing to reconcile against. */
  changes: Change[];
  at: number;
  operationKey?: string;
  actionId?: string;
  planId?: string;
  operationIndex?: number;
  /** Who ran the capability whose commit became unknown. */
  executedBy?: Actor;
  /** The state digest the approval was bound to, when it had one. */
  stateVersion?: string;
  /** The grant that authorized the execution, when one did. */
  grantId?: string;
  artifact: PersistedArtifact;
  seal: string;
};

/**
 * An idempotency key that was claimed. Only the claim survives a restart,
 * not the result it produced, so a repeat after reload is refused rather
 * than replayed: the write may have landed, and nothing can hand back what
 * it returned.
 */
export type PersistedIdempotencyClaim = {
  version: 1;
  /** `capability:key`, the same slot the in-memory store uses. */
  slot: string;
  fingerprint: string;
  at: number;
};

/**
 * The seam. Every method may be synchronous or return a promise; the
 * runtime awaits the loads at `start` and queues the saves in order.
 *
 * `resolveArtifact` is synchronous, because `reconcile` is: it is handed a
 * loaded record and returns the live artifact the staging adapter can
 * settle, or `undefined` when it cannot rebuild one, in which case the
 * record stays open and `reconcile` says so.
 */
export type PersistenceAdapter = {
  saveRecord: (record: PersistedRecord) => void | Promise<void>;
  /** Removes a settled record so it does not come back on the next start. */
  settleRecord: (id: string) => void | Promise<void>;
  loadOpenRecords: () => PersistedRecord[] | Promise<PersistedRecord[]>;
  saveIdempotencyClaim: (claim: PersistedIdempotencyClaim) => void | Promise<void>;
  loadIdempotencyClaims: () =>
    | PersistedIdempotencyClaim[]
    | Promise<PersistedIdempotencyClaim[]>;
  resolveArtifact?: (record: PersistedRecord) => unknown;
};

/**
 * In memory. The default when a runtime declares no persistence, so that
 * runtime behaves exactly as it did, and the double the tests use: two
 * runtimes that share one of these share a restart.
 */
export function memoryPersistence(): PersistenceAdapter & {
  records: Map<string, PersistedRecord>;
  claims: Map<string, PersistedIdempotencyClaim>;
  resolveArtifact?: (record: PersistedRecord) => unknown;
} {
  const records = new Map<string, PersistedRecord>();
  const claims = new Map<string, PersistedIdempotencyClaim>();
  return {
    records,
    claims,
    saveRecord: (record) => {
      records.set(record.id, structuredClone(record));
    },
    settleRecord: (id) => {
      records.delete(id);
    },
    loadOpenRecords: () => [...records.values()].map((record) => structuredClone(record)),
    saveIdempotencyClaim: (claim) => {
      claims.set(claim.slot, structuredClone(claim));
    },
    loadIdempotencyClaims: () => [...claims.values()].map((claim) => structuredClone(claim)),
  };
}

/** What the IndexedDB adapter needs of the platform, injectable for tests. */
export type IndexedDbLike = {
  open: (name: string, version?: number) => IDBOpenDBRequest;
};

export type IndexedDbPersistenceOptions = {
  /** Database name. One per application, so two apps on an origin do not share records. */
  name?: string;
  /** The factory to use; defaults to the global `indexedDB`. */
  indexedDB?: IndexedDbLike;
  resolveArtifact?: (record: PersistedRecord) => unknown;
};

/** Ships with the runtime; implemented in the fix that follows the tests. */
export function indexedDbPersistence(
  options: IndexedDbPersistenceOptions = {},
): PersistenceAdapter {
  void options;
  return {
    saveRecord: () => {},
    settleRecord: () => {},
    loadOpenRecords: () => [],
    saveIdempotencyClaim: () => {},
    loadIdempotencyClaims: () => [],
  };
}
