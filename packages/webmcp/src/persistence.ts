import type { Change } from "./capability.ts";
import type { Actor } from "./plan.ts";
import { digestOf } from "./staging.ts";

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
  /**
   * The receipt the claimed execution recorded, when it recorded one. After
   * a restart the result is gone, but the receipt id is the evidence a
   * refusal can point a person at.
   */
  receiptId?: string;
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
  /**
   * Forgets every record and every claim. The runtime never calls it; a
   * page's Reset does, so a reset that must also forget durable state has
   * one call to make that does not name the adapter's stores by hand.
   */
  clear: () => void | Promise<void>;
  resolveArtifact?: (record: PersistedRecord) => unknown;
};

/** The seal over everything but the seal itself. */
export function sealOf(record: Omit<PersistedRecord, "seal">): string {
  return digestOf(record);
}

/**
 * Whether a loaded record is what was saved. The version is checked so a
 * future shape is refused rather than misread, and the seal so a record
 * whose evidence changed on disk is refused rather than trusted.
 */
export function verifyRecord(
  value: unknown,
): { ok: true; record: PersistedRecord } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "a persisted record must be an object" };
  }
  const record = value as PersistedRecord;
  if (record.version !== 1) {
    return { ok: false, reason: `unsupported persisted record version ${String(record.version)}` };
  }
  if (typeof record.id !== "string" || typeof record.seal !== "string") {
    return { ok: false, reason: "a persisted record needs an id and a seal" };
  }
  const { seal, ...rest } = record;
  if (sealOf(rest) !== seal) {
    return {
      ok: false,
      reason: "the evidence seal does not match: the record was changed after it was saved",
    };
  }
  return { ok: true, record };
}

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
    clear: () => {
      records.clear();
      claims.clear();
    },
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

const RECORDS = "records";
const CLAIMS = "claims";

/**
 * IndexedDB, one database per application. Two object stores, records
 * keyed by id and claims keyed by slot. Opened lazily on first use and
 * once; every operation is one transaction, so a failed write rejects
 * rather than half-lands.
 */
export function indexedDbPersistence(
  options: IndexedDbPersistenceOptions = {},
): PersistenceAdapter {
  const name = options.name ?? "agentdesk";
  const factory =
    options.indexedDB ?? (globalThis as { indexedDB?: IndexedDbLike }).indexedDB;
  let opening: Promise<IDBDatabase> | undefined;

  const database = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (factory === undefined) {
        reject(new Error("IndexedDB is not available in this environment"));
        return;
      }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS)) {
          db.createObjectStore(RECORDS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CLAIMS)) {
          db.createObjectStore(CLAIMS, { keyPath: "slot" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return opening;
  };

  const run = <T,>(
    store: string,
    mode: IDBTransactionMode,
    operation: (objectStore: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    database().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const request = operation(db.transaction(store, mode).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        }),
    );

  return {
    saveRecord: (record) => run(RECORDS, "readwrite", (s) => s.put(record)).then(() => undefined),
    settleRecord: (id) => run(RECORDS, "readwrite", (s) => s.delete(id)).then(() => undefined),
    loadOpenRecords: () => run<PersistedRecord[]>(RECORDS, "readonly", (s) => s.getAll()),
    saveIdempotencyClaim: (claim) =>
      run(CLAIMS, "readwrite", (s) => s.put(claim)).then(() => undefined),
    loadIdempotencyClaims: () =>
      run<PersistedIdempotencyClaim[]>(CLAIMS, "readonly", (s) => s.getAll()),
    clear: () =>
      run(RECORDS, "readwrite", (s) => s.clear())
        .then(() => run(CLAIMS, "readwrite", (s) => s.clear()))
        .then(() => undefined),
    ...(options.resolveArtifact !== undefined
      ? { resolveArtifact: options.resolveArtifact }
      : {}),
  };
}
