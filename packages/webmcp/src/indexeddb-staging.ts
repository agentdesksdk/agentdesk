import { CapabilityUnavailableError, unavailable, type Change } from "./capability.ts";
import type { IndexedDbLike, PersistedRecord } from "./persistence.ts";
import { digestOf, StagedCommitRefused, type StagingAdapter } from "./staging.ts";

/** A row this adapter governs. `version` is the adapter's; an operation never sets it. */
export type IndexedDbRow = { id: string; version?: number; [field: string]: unknown };

/** What an operation sees: the fork, read through to live rows it has not touched. */
export type IndexedDbDraft = {
  get: (store: string, id: string) => IndexedDbRow | undefined;
  put: (store: string, row: IndexedDbRow) => void;
};

export type IndexedDbOperation = (
  draft: IndexedDbDraft,
  input: Record<string, unknown>,
) => unknown;

/** One row as the fork found it: its version, or `null` when it did not exist. */
export type IndexedDbBaseRow = {
  store: string;
  id: string;
  version: number | null;
  row?: IndexedDbRow;
};

export type IndexedDbHeadRow = { store: string; id: string; row: IndexedDbRow };

/**
 * One staged run of one operation.
 *
 * `base` is every row the operation read or wrote, at the version it had, so
 * a commit can tell whether the state the human reviewed is still the state.
 * `head` is every row it wrote, already carrying the version it will land
 * with. Both are persisted under `id` the moment the fork opens.
 */
export type IndexedDbFork = {
  readonly id: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly base: readonly IndexedDbBaseRow[];
  readonly head: readonly IndexedDbHeadRow[];
  readonly result: unknown;
  /**
   * The operation this fork ran. A function, so the artifact does not
   * clone: a persisted record keeps the fork id rather than a second copy of
   * the rows, and the staging store stays the one authority on them.
   */
  readonly run: IndexedDbOperation;
  settled: boolean;
};

export type IndexedDbStagingOptions = {
  /** Database name. */
  name: string;
  /** Database version the adapter opens; bump it when `stores` grows. */
  version?: number;
  /** The factory to use; defaults to the global `indexedDB`. */
  indexedDB?: IndexedDbLike;
  /** Object stores the operations may read and write, each keyed by `id`. */
  stores: readonly string[];
  operations: Record<string, IndexedDbOperation>;
};

export type IndexedDbStagingAdapter = StagingAdapter<IndexedDbFork> & {
  identify: (fork: IndexedDbFork) => { fork: string; operation: string };
  /** Loads the governed rows and any open forks. Must settle before the first fork. */
  open: () => Promise<void>;
  /** Settles every write dispatched so far; rejects with the first that IndexedDB refused. */
  flush: () => Promise<void>;
  /** A governed row as this process last saw it. */
  read: (store: string, id: string) => IndexedDbRow | undefined;
  /** Rebuilds a fork from the id `identify` gave a persisted record. */
  resolveArtifact: (record: PersistedRecord) => IndexedDbFork | undefined;
};

/** The object store open forks live in, next to the application's own. */
export const STAGING_STORE = "agentdesk_staging";

/** What the staging store keeps of a fork: everything but the function. */
type StoredFork = Omit<IndexedDbFork, "run" | "settled">;

const key = (store: string, id: string): string => `${store}/${id}`;

/** A row's version: the integer it carries, 0 when it carries none, null when it is absent. */
const versionOf = (row: IndexedDbRow | undefined): number | null =>
  row === undefined ? null : typeof row.version === "number" ? row.version : 0;

/**
 * A staging adapter over IndexedDB.
 *
 * Fork and diff are synchronous and IndexedDB is not, so the adapter keeps
 * an in-process mirror of the rows it governs, loaded once by `open`, and
 * forks derive against it. Commit is one readwrite transaction whose
 * outcome is the commit's outcome: it re-checks every base row's version
 * and aborts if any moved, so a second tab's write is refused by the
 * database even though this process could not see it, and the promise it
 * returns settles only when the transaction has. The mirror moves when the
 * transaction completes and not before, so a refused commit leaves it as it
 * was. When a transaction aborts, IndexedDB itself discards every write in
 * it; the adapter does nothing to undo, because there is nothing to undo.
 *
 * A fork opened while a commit is in flight derives against the rows as
 * they were, without waiting, because fork cannot wait; its own commit is
 * then refused by the version check, which is what a fork against rows that
 * moved deserves. Fork rows and releases still go through one serialized
 * queue that `flush` settles, so a fork's row is written before the commit
 * that deletes it.
 */
export function indexedDbStaging(options: IndexedDbStagingOptions): IndexedDbStagingAdapter {
  const factory =
    options.indexedDB ?? (globalThis as { indexedDB?: IndexedDbLike }).indexedDB;
  const stores = [...options.stores];
  const mirror = new Map<string, Map<string, IndexedDbRow>>(
    stores.map((store) => [store, new Map()]),
  );
  /** Every fork this process knows: opened here, or loaded from the staging store. */
  const forks = new Map<string, IndexedDbFork>();
  let db: IDBDatabase | undefined;

  // The plan overlay: staged heads from earlier forks in the same scope, so
  // a later one derives against them rather than against live rows.
  let overlay: Map<string, IndexedDbRow> | null = null;

  // ponytail: one queue for all IndexedDB work, so a fork's row is written
  // before the commit that deletes it; per-store queues if this serializes
  // too much. A commit's own outcome goes to its caller; everything else
  // reports through flush().
  let queue: Promise<void> = Promise.resolve();
  const faults: Error[] = [];
  const enqueue = (work: (database: IDBDatabase) => Promise<void>): void => {
    queue = queue
      .then(() => work(opened()))
      .catch((err: unknown) => {
        faults.push(err instanceof Error ? err : new Error(String(err)));
      });
  };
  const after = <T,>(work: (database: IDBDatabase) => Promise<T>): Promise<T> => {
    const outcome = queue.then(() => work(opened()));
    queue = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  };

  const opened = (): IDBDatabase => {
    if (db === undefined) {
      throw new Error(`indexedDbStaging(${options.name}): open() has not completed`);
    }
    return db;
  };

  const settle = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });

  const getAll = <T,>(tx: IDBTransaction, store: string): Promise<T[]> =>
    new Promise((resolve, reject) => {
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });

  const openDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      if (factory === undefined) {
        reject(new Error("IndexedDB is not available in this environment"));
        return;
      }
      const request = factory.open(options.name, options.version ?? 1);
      request.onupgradeneeded = () => {
        const upgrading = request.result;
        for (const store of [...stores, STAGING_STORE]) {
          if (!upgrading.objectStoreNames.contains(store)) {
            upgrading.createObjectStore(store, { keyPath: "id" });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });

  const live = (store: string, id: string): IndexedDbRow | undefined =>
    overlay?.get(key(store, id)) ?? mirror.get(store)?.get(id);

  const drop = (fork: IndexedDbFork): void => {
    fork.settled = true;
    forks.delete(fork.id);
  };

  const forget = (fork: IndexedDbFork): void => {
    drop(fork);
    enqueue((database) => {
      const tx = database.transaction(STAGING_STORE, "readwrite");
      tx.objectStore(STAGING_STORE).delete(fork.id);
      return settle(tx);
    });
  };

  const stale = (fork: IndexedDbFork, moved: IndexedDbBaseRow[]): never => {
    forget(fork);
    throw new CapabilityUnavailableError(
      unavailable(
        "APPROVAL_STALE",
        `${moved
          .map((row) => `${row.store} ${row.id}`)
          .join(", ")} changed after this was proposed, so approving it would apply a change reviewed against state that is gone. Request the action again to review it against current state.`,
        fork.operation,
      ),
    );
  };

  const adapter: IndexedDbStagingAdapter = {
    operations: new Set(Object.keys(options.operations)),

    scope: (run) => {
      const outermost = overlay === null;
      overlay ??= new Map();
      try {
        return run();
      } finally {
        if (outermost) {
          overlay = null;
        }
      }
    },

    // `previous` is ignored: nothing here is pinned to a clock or a seed, so
    // a second run of the same input against the same rows is the same run.
    fork(operation, input) {
      const run = options.operations[operation];
      if (run === undefined) {
        throw new Error(`no staged operation named ${operation}`);
      }
      opened();
      const base = new Map<string, IndexedDbBaseRow>();
      const head = new Map<string, IndexedDbHeadRow>();
      const touch = (store: string, id: string): void => {
        if (!mirror.has(store)) {
          throw new Error(`indexedDbStaging(${options.name}) does not govern the ${store} store`);
        }
        const k = key(store, id);
        if (!base.has(k)) {
          const row = live(store, id);
          base.set(k, {
            store,
            id,
            version: versionOf(row),
            ...(row === undefined ? {} : { row: structuredClone(row) }),
          });
        }
      };
      const draft: IndexedDbDraft = {
        get: (store, id) => {
          touch(store, id);
          const row = head.get(key(store, id))?.row ?? live(store, id);
          return row === undefined ? undefined : structuredClone(row);
        },
        put: (store, row) => {
          const id = String(row.id);
          touch(store, id);
          const from = base.get(key(store, id))!;
          // The version the row lands with, fixed here so a later fork in the
          // same plan derives against it and a commit writes exactly it.
          head.set(key(store, id), {
            store,
            id,
            row: { ...structuredClone(row), id, version: (from.version ?? 0) + 1 },
          });
        },
      };
      const result = run(draft, input);
      const fork: IndexedDbFork = {
        id: forkId(),
        operation,
        input,
        base: [...base.values()],
        head: [...head.values()],
        result,
        run,
        settled: false,
      };
      if (overlay !== null) {
        for (const entry of fork.head) {
          overlay.set(key(entry.store, entry.id), entry.row);
        }
      }
      forks.set(fork.id, fork);
      const stored: StoredFork = {
        id: fork.id,
        operation,
        input: structuredClone(input),
        base: fork.base,
        head: fork.head,
        result: cloneable(result) ? result : undefined,
      };
      enqueue((database) => {
        const tx = database.transaction(STAGING_STORE, "readwrite");
        tx.objectStore(STAGING_STORE).put(stored);
        return settle(tx);
      });
      return { staged: fork, result };
    },

    diff: (fork) => {
      const changes: Change[] = [];
      for (const { store, id, row } of fork.head) {
        const before = fork.base.find((b) => b.store === store && b.id === id)?.row;
        const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(row)]);
        fields.delete("id");
        fields.delete("version");
        for (const field of fields) {
          const was = before?.[field] ?? null;
          const now = row[field] ?? null;
          if (digestOf(was) !== digestOf(now)) {
            changes.push({ field: `${store}:${id}.${field}`, before: was, after: now });
          }
        }
      }
      return changes;
    },

    // Always a promise, so a refusal before dispatch and a refusal from the
    // database reach the caller the same way.
    commit: async (fork) => {
      if (fork.settled || !forks.has(fork.id)) {
        throw new StagedCommitRefused(
          `${fork.operation} was already released, so there is nothing left to commit`,
        );
      }
      const moved = fork.base.filter(
        (row) => versionOf(mirror.get(row.store)?.get(row.id)) !== row.version,
      );
      if (moved.length > 0) {
        stale(fork, moved);
      }
      drop(fork);
      // Every store the fork read or wrote, since a read-only base row still
      // has to be re-read inside the transaction.
      const touched = [...new Set([...fork.base, ...fork.head].map((row) => row.store))];
      return after((database) => {
        const tx = database.transaction([...touched, STAGING_STORE], "readwrite");
        let unchecked = fork.base.length;
        let unwritten = fork.head.length + 1;
        let refused: Error | undefined;
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          // An abort is IndexedDB's own word that it rolled back, except
          // when it arrives with no error after every write was accepted:
          // that is a connection lost while committing, and the spec does
          // not promise the commit had not happened.
          tx.onabort = () => {
            const error = tx.error as { message?: string } | null | undefined;
            if (refused !== undefined) {
              reject(refused);
            } else if (error) {
              reject(
                new StagedCommitRefused(
                  `${fork.operation} was not committed: IndexedDB aborted the transaction and rolled it back: ${error.message ?? String(error)}`,
                ),
              );
            } else if (unwritten === 0) {
              reject(
                new Error(
                  `${fork.operation} may have been committed: the transaction was aborted with no error after every write was accepted, so whether it landed is unknown`,
                ),
              );
            } else {
              reject(
                new StagedCommitRefused(
                  `${fork.operation} was not committed: the transaction was aborted before its writes were accepted`,
                ),
              );
            }
          };
        });
        const accepted = () => {
          unwritten -= 1;
        };
        const write = () => {
          for (const { store, row } of fork.head) {
            tx.objectStore(store).put(row).onsuccess = accepted;
          }
          tx.objectStore(STAGING_STORE).delete(fork.id).onsuccess = accepted;
        };
        if (unchecked === 0) {
          write();
        }
        for (const expected of fork.base) {
          const request = tx.objectStore(expected.store).get(expected.id);
          request.onsuccess = () => {
            if (versionOf(request.result as IndexedDbRow | undefined) !== expected.version) {
              // Nothing has been written yet, and nothing will be: aborting
              // discards the transaction, and IndexedDB rolls back whatever
              // it held.
              refused = new CapabilityUnavailableError(
                unavailable(
                  "APPROVAL_STALE",
                  `${expected.store} ${expected.id} changed in the database after this was proposed, so approving it would apply a change reviewed against state that is gone. Request the action again to review it against current state.`,
                  fork.operation,
                ),
              );
              tx.abort();
              return;
            }
            unchecked -= 1;
            if (unchecked === 0) {
              write();
            }
          };
        }
        return done.then(() => {
          // The transaction is the authority; the mirror follows it.
          for (const { store, id, row } of fork.head) {
            mirror.get(store)!.set(id, structuredClone(row));
          }
          return fork.result;
        });
      });
    },

    release: forget,

    // Whatever the human found, the fork is finished: an applied commit
    // already reached the database and a rejected one never will.
    reconcile: forget,

    identify: (fork) => ({ fork: fork.id, operation: fork.operation }),

    open: async () => {
      db = await openDatabase();
      // Every read is issued before any is awaited, so the transaction is
      // never asked for a request after it has gone inactive.
      const tx = db.transaction([...stores, STAGING_STORE], "readonly");
      const reads = stores.map((store) => getAll<IndexedDbRow>(tx, store));
      const open = getAll<StoredFork>(tx, STAGING_STORE);
      for (const [index, store] of stores.entries()) {
        const rows = await reads[index]!;
        mirror.set(store, new Map(rows.map((row) => [String(row.id), row])));
      }
      for (const stored of await open) {
        const run = options.operations[stored.operation];
        if (run !== undefined) {
          forks.set(stored.id, { ...stored, run, settled: false });
        }
      }
    },

    flush: async () => {
      await queue;
      const fault = faults.shift();
      if (fault !== undefined) {
        throw fault;
      }
    },

    read: (store, id) => {
      const row = mirror.get(store)?.get(id);
      return row === undefined ? undefined : structuredClone(row);
    },

    /**
     * The fork under the id a record kept, or, when the staging store no
     * longer has it, an empty fork under that id. A fork's row is deleted
     * only in its commit's own transaction or by a release, so a row that is
     * gone after a reload is one whose commit completed or that was never
     * going to land; either way there is nothing left to hand back but the
     * name, and a person settling the record needs the name.
     */
    resolveArtifact: (record) => {
      if (record.artifact.kind !== "reference") {
        return undefined;
      }
      const reference = record.artifact.reference as
        | { fork?: unknown; operation?: unknown }
        | null;
      const id = reference?.fork;
      const operation = reference?.operation;
      if (typeof id !== "string" || typeof operation !== "string") {
        return undefined;
      }
      const run = options.operations[operation];
      if (run === undefined) {
        return undefined;
      }
      return (
        forks.get(id) ?? {
          id,
          operation,
          input: {},
          base: [],
          head: [],
          result: undefined,
          run,
          settled: false,
        }
      );
    },
  };

  return adapter;
}

function forkId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  return random === undefined
    ? `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    : random.call(globalThis.crypto);
}

function cloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}
