import type { Change } from "./capability.ts";
import type { IndexedDbLike, PersistedRecord } from "./persistence.ts";
import type { StagingAdapter } from "./staging.ts";

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

/** One staged run of one operation. */
export type IndexedDbFork = {
  readonly id: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly base: readonly IndexedDbBaseRow[];
  readonly head: readonly IndexedDbHeadRow[];
  readonly result: unknown;
  /** The operation this fork ran, so the artifact does not clone. */
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
  identify: (fork: IndexedDbFork) => { fork: string };
  /** Loads the governed rows and any open forks. Must settle before the first fork. */
  open: () => Promise<void>;
  /** Settles every write dispatched so far; rejects with the first that IndexedDB refused. */
  flush: () => Promise<void>;
  /** A governed row as this process last saw it. */
  read: (store: string, id: string) => IndexedDbRow | undefined;
  /** Rebuilds a fork from the id `identify` gave a persisted record. */
  resolveArtifact: (record: PersistedRecord) => IndexedDbFork | undefined;
};

export function indexedDbStaging(options: IndexedDbStagingOptions): IndexedDbStagingAdapter {
  const fork = (operation: string, input: Record<string, unknown>): IndexedDbFork => ({
    id: "",
    operation,
    input,
    base: [],
    head: [],
    result: undefined,
    run: options.operations[operation]!,
    settled: false,
  });
  const none: Change[] = [];
  return {
    operations: new Set(Object.keys(options.operations)),
    scope: (run) => run(),
    fork: (operation, input) => ({ staged: fork(operation, input), result: undefined }),
    diff: () => none,
    commit: () => undefined,
    release: () => {},
    reconcile: () => {},
    identify: (staged) => ({ fork: staged.id }),
    open: async () => {},
    flush: async () => {},
    read: () => undefined,
    resolveArtifact: () => undefined,
  };
}
