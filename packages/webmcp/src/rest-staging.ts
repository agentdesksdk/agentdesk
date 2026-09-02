import type { Change } from "./capability.ts";
import type { PersistedRecord } from "./persistence.ts";
import type { StagingAdapter } from "./staging.ts";

/** A row a REST resource represents. */
export type RestRow = { id: string; [field: string]: unknown };

/** Where a resource's version comes from: the `ETag` header, or a field in the body. */
export type RestVersionSource = "etag" | { field: string };

export type RestResource = {
  /** The row's path under `baseUrl`. */
  path: (id: string) => string;
  version: RestVersionSource;
};

export type RestRowRef = { resource: string; id: string };

/** What an operation sees: the rows it named, read through to what was fetched. */
export type RestDraft = {
  get: (resource: string, id: string) => RestRow | undefined;
  put: (resource: string, row: RestRow) => void;
};

export type RestOperation = {
  /** The rows this operation will read or write for `input`, fetched by `prepare`. */
  rows: (input: Record<string, unknown>) => RestRowRef[];
  run: (draft: RestDraft, input: Record<string, unknown>) => unknown;
};

/** One row as the fork found it, at the version the server reported. */
export type RestBaseRow = {
  resource: string;
  id: string;
  version: string;
  row?: RestRow;
  /** The fork whose acknowledged version replaces `version` at commit, inside a scope. */
  follows?: string;
};

export type RestHeadRow = { resource: string; id: string; row: RestRow };

/** A write the server acknowledged, with the version it reported back. */
export type RestAcknowledged = { resource: string; id: string; version: string };

export type RestFork = {
  readonly id: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly base: readonly RestBaseRow[];
  readonly head: readonly RestHeadRow[];
  readonly result: unknown;
  /** The operation this fork ran. A function, so the artifact does not clone. */
  readonly run: RestOperation["run"];
  /** Filled in by commit, in the order the server acknowledged. */
  readonly acknowledged: RestAcknowledged[];
  settled: boolean;
};

export type RestStagingOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  resources: Record<string, RestResource>;
  operations: Record<string, RestOperation>;
  /** A batch endpoint that applies every write or none; absent, writes go one per row. */
  batch?: { path: string };
};

export type RestStagingAdapter = StagingAdapter<RestFork> & {
  identify: (fork: RestFork) => { fork: string; operation: string; input: Record<string, unknown> };
  /** Fetches the rows `operation` names for `input`, so the fork that follows can be synchronous. */
  prepare: (operation: string, input: Record<string, unknown>) => Promise<void>;
  /** Rebuilds a fork from the reference `identify` gave a persisted record. */
  resolveArtifact: (record: PersistedRecord) => RestFork | undefined;
};

/**
 * A commit that stopped after some writes were acknowledged, or with one in
 * flight. REST has no transaction, so this is neither applied nor not
 * applied: it names every row the server acknowledged, the row it refused
 * or the row whose answer was lost, and the rows never sent.
 */
export class RestCommitPartial extends Error {
  readonly acknowledged: RestAcknowledged[];
  readonly refused?: RestRowRef;
  readonly unknown?: RestRowRef;
  readonly unsent: RestRowRef[];

  constructor(
    message: string,
    outcome: {
      acknowledged: RestAcknowledged[];
      refused?: RestRowRef;
      unknown?: RestRowRef;
      unsent: RestRowRef[];
    },
  ) {
    super(message);
    this.name = "RestCommitPartial";
    this.acknowledged = outcome.acknowledged;
    if (outcome.refused !== undefined) {
      this.refused = outcome.refused;
    }
    if (outcome.unknown !== undefined) {
      this.unknown = outcome.unknown;
    }
    this.unsent = outcome.unsent;
  }
}

export function restStaging(options: RestStagingOptions): RestStagingAdapter {
  const fork = (operation: string, input: Record<string, unknown>): RestFork => ({
    id: "",
    operation,
    input,
    base: [],
    head: [],
    result: undefined,
    run: options.operations[operation]!.run,
    acknowledged: [],
    settled: false,
  });
  const none: Change[] = [];
  return {
    operations: new Set(Object.keys(options.operations)),
    scope: (run) => run(),
    fork: (operation, input) => ({ staged: fork(operation, input), result: undefined }),
    diff: () => none,
    commit: async () => undefined,
    release: () => {},
    reconcile: () => {},
    identify: (staged) => ({ fork: staged.id, operation: staged.operation, input: staged.input }),
    prepare: async () => {},
    resolveArtifact: () => undefined,
  };
}
