import { CapabilityUnavailableError, unavailable, type Change } from "./capability.ts";
import type { PersistedRecord } from "./persistence.ts";
import { digestOf, isThenable, StagedCommitRefused, type StagingAdapter } from "./staging.ts";

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
  /** The rows this operation will read or write for `input`; fork fetches them first. */
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

/**
 * One staged run of one operation.
 *
 * `base` is every row the fork fetched for it, at the version the server
 * reported; `head` is every row the operation wrote. `acknowledged` fills
 * in during commit, in the order the server answered, and is what a person
 * reconciles against when the commit stopped part way.
 */
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
  /**
   * A batch endpoint, declared atomic on the integrator's word: every write
   * in it lands or none does, which is what lets its 412 be reported as a
   * refusal with nothing written. Absent, writes go one per row.
   */
  batch?: { path: string; atomic: true };
};

export type RestStagingAdapter = StagingAdapter<RestFork> & {
  identify: (fork: RestFork) => { fork: string; operation: string; input: Record<string, unknown> };
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

const key = (resource: string, id: string): string => `${resource}/${id}`;
const name = (row: RestRowRef): string => `${row.resource} ${row.id}`;

/**
 * A staging adapter over a REST backend with optimistic concurrency.
 *
 * Fork fetches the rows the operation names through its `rows(input)`,
 * records each one's version from the `ETag` header or the field the
 * resource declares, and runs the operation against them; the runtime
 * awaits it. A resource that offers neither version source is refused at
 * fork rather than guessed at. Inside a scope the forks run one after
 * another, so a later one derives against the staged head of the one
 * before it, and the scope stays open until the whole chain has settled.
 *
 * Commit sends every staged row with `If-Match` on its recorded version.
 * With a batch endpoint that is one request, and the backend's 412 is a
 * refusal of the whole batch. Without one, writes go one per row in the
 * order the operation wrote them, and REST has no transaction: a 412 on
 * the first write refuses with nothing written, but a 412 after a row was
 * acknowledged, or a network failure on any write, is `RestCommitPartial`,
 * which the runtime records as indeterminate with the rows acknowledged,
 * the row refused or in flight, and the rows never sent. Nothing is ever
 * retried, because an error does not prove the write did not land.
 */
export function restStaging(options: RestStagingOptions): RestStagingAdapter {
  const call = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  const forks = new Map<string, RestFork>();
  /** The newest version this adapter has seen a row acknowledged at, by fork. */
  const acknowledgedBy = new Map<string, Map<string, string>>();
  let overlay: Map<string, { row: RestRow; fork: string }> | null = null;

  const resource = (named: string): RestResource => {
    const found = options.resources[named];
    if (found === undefined) {
      throw new Error(`restStaging does not declare a ${named} resource`);
    }
    return found;
  };

  const url = (path: string): string => `${options.baseUrl}${path}`;

  const request = (path: string, init: RequestInit): Promise<Response> => {
    if (call === undefined) {
      throw new Error("fetch is not available in this environment");
    }
    return call(url(path), {
      ...init,
      headers: { ...options.headers, ...(init.headers as Record<string, string> | undefined) },
    });
  };

  /** The version a response carries for `resource`, or undefined when it carries none. */
  const versionIn = (
    source: RestVersionSource,
    response: Response,
    body: Record<string, unknown>,
  ): string | undefined => {
    if (source === "etag") {
      return response.headers.get("etag") ?? undefined;
    }
    const value = body[source.field];
    return value === undefined || value === null ? undefined : String(value);
  };

  /** What `If-Match` carries: an ETag as it came, a field value quoted as an entity tag. */
  const entityTag = (source: RestVersionSource, version: string): string =>
    source === "etag" ? version : `"${version}"`;

  const drop = (fork: RestFork): void => {
    fork.settled = true;
    forks.delete(fork.id);
  };

  const stale = (fork: RestFork, rows: RestRowRef[]): never => {
    drop(fork);
    throw new CapabilityUnavailableError(
      unavailable(
        "APPROVAL_STALE",
        `${rows.map(name).join(", ")} changed on the server after this was proposed, so approving it would apply a change reviewed against state that is gone. Request the action again to review it against current state.`,
        fork.operation,
      ),
    );
  };

  /** The version a write must match: the base version, or what the fork it follows was acknowledged at. */
  const matchVersion = (fork: RestFork, base: RestBaseRow): string => {
    if (base.follows === undefined) {
      return base.version;
    }
    const seen = acknowledgedBy.get(base.follows)?.get(key(base.resource, base.id));
    if (seen === undefined) {
      drop(fork);
      throw new StagedCommitRefused(
        `${fork.operation} was derived against ${name(base)} as staged by an earlier operation that has not been acknowledged, so there is no version to commit under`,
      );
    }
    return seen;
  };

  /** The rows an operation names, each at the version the server reports now. */
  const fetchRows = async (
    declared: RestOperation,
    input: Record<string, unknown>,
  ): Promise<RestBaseRow[]> => {
    const rows: RestBaseRow[] = [];
    for (const ref of declared.rows(input)) {
      const source = resource(ref.resource);
      const response = await request(source.path(ref.id), { method: "GET" });
      if (!response.ok) {
        throw new Error(`${name(ref)} could not be staged: the server answered ${response.status}`);
      }
      const body = (await response.json()) as RestRow;
      const version = versionIn(source.version, response, body);
      if (version === undefined) {
        throw new Error(
          source.version === "etag"
            ? `${name(ref)} cannot be staged: the server sent no ETag, so there is no version to commit under`
            : `${name(ref)} cannot be staged: the server sent no ${source.version.field} field, so there is no version to commit under`,
        );
      }
      rows.push({ resource: ref.resource, id: ref.id, version, row: body });
    }
    return rows;
  };

  const adapter: RestStagingAdapter = {
    operations: new Set(Object.keys(options.operations)),

    scope: (run) => {
      const outermost = overlay === null;
      overlay ??= new Map();
      const close = () => {
        if (outermost) {
          overlay = null;
        }
      };
      let outcome: ReturnType<typeof run>;
      try {
        outcome = run();
      } catch (err) {
        close();
        throw err;
      }
      // Forks here answer later, so the scope closes when the chain does.
      if (isThenable(outcome)) {
        return (outcome as unknown as Promise<unknown>).then(
          (value) => {
            close();
            return value;
          },
          (err: unknown) => {
            close();
            throw err;
          },
        ) as unknown as ReturnType<typeof run>;
      }
      close();
      return outcome;
    },

    // `previous` is ignored: nothing here is pinned to a clock or a seed.
    fork: async (operation, input) => {
      const declared = options.operations[operation];
      if (declared === undefined) {
        throw new Error(`no staged operation named ${operation}`);
      }
      const fetched = await fetchRows(declared, input);
      const base = new Map<string, RestBaseRow>();
      for (const row of fetched) {
        const k = key(row.resource, row.id);
        const staged = overlay?.get(k);
        base.set(
          k,
          staged === undefined
            ? row
            : { ...row, row: structuredClone(staged.row), follows: staged.fork },
        );
      }
      const head = new Map<string, RestHeadRow>();
      const draft: RestDraft = {
        get: (named, id) => {
          const found = head.get(key(named, id))?.row ?? base.get(key(named, id))?.row;
          if (found === undefined && !base.has(key(named, id))) {
            throw new Error(`${operation} read ${named} ${id}, which it did not name in rows()`);
          }
          return found === undefined ? undefined : structuredClone(found);
        },
        put: (named, row) => {
          const id = String(row.id);
          if (!base.has(key(named, id))) {
            throw new Error(`${operation} wrote ${named} ${id}, which it did not name in rows()`);
          }
          head.set(key(named, id), { resource: named, id, row: { ...structuredClone(row), id } });
        },
      };
      const result = declared.run(draft, input);
      const fork: RestFork = {
        id: forkId(),
        operation,
        input,
        base: [...base.values()],
        head: [...head.values()],
        result,
        run: declared.run,
        acknowledged: [],
        settled: false,
      };
      if (overlay !== null) {
        for (const entry of fork.head) {
          overlay.set(key(entry.resource, entry.id), { row: entry.row, fork: fork.id });
        }
      }
      forks.set(fork.id, fork);
      return { staged: fork, result };
    },

    diff: (fork) => {
      const changes: Change[] = [];
      for (const { resource: named, id, row } of fork.head) {
        const before = fork.base.find((b) => b.resource === named && b.id === id)?.row;
        const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(row)]);
        fields.delete("id");
        const source = options.resources[named]?.version;
        if (source !== undefined && source !== "etag") {
          fields.delete(source.field);
        }
        for (const field of fields) {
          const was = before?.[field] ?? null;
          const now = row[field] ?? null;
          if (digestOf(was) !== digestOf(now)) {
            changes.push({ field: `${named}:${id}.${field}`, before: was, after: now });
          }
        }
      }
      return changes;
    },

    commit: async (fork) => {
      if (fork.settled || !forks.has(fork.id)) {
        throw new StagedCommitRefused(
          `${fork.operation} was already released, so there is nothing left to commit`,
        );
      }
      const writes = fork.head.map((entry) => {
        const base = fork.base.find((b) => b.resource === entry.resource && b.id === entry.id)!;
        const source = resource(entry.resource);
        return {
          ref: { resource: entry.resource, id: entry.id },
          path: source.path(entry.id),
          source,
          ifMatch: entityTag(source.version, matchVersion(fork, base)),
          body: entry.row,
        };
      });
      const seen = new Map<string, string>();
      acknowledgedBy.set(fork.id, seen);
      const acknowledge = (ref: RestRowRef, version: string): void => {
        fork.acknowledged.push({ ...ref, version });
        seen.set(key(ref.resource, ref.id), version);
      };

      if (options.batch !== undefined) {
        // One request, and the backend's word that it applied all or none.
        let response: Response;
        try {
          response = await request(options.batch.path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              writes: writes.map((write) => ({
                method: "PUT",
                path: write.path,
                ifMatch: write.ifMatch,
                body: write.body,
              })),
            }),
          });
        } catch (err) {
          drop(fork);
          throw new RestCommitPartial(
            `${fork.operation} may have been committed: the batch request failed (${
              err instanceof Error ? err.message : String(err)
            }) after it was sent, and the server's answer is unknown`,
            { acknowledged: [], unknown: writes[0]!.ref, unsent: writes.slice(1).map((w) => w.ref) },
          );
        }
        if (response.status === 412) {
          stale(fork, writes.map((write) => write.ref));
        }
        if (response.status >= 400 && response.status < 500) {
          drop(fork);
          throw new StagedCommitRefused(
            `${fork.operation} was not committed: the server refused the batch with ${response.status}`,
          );
        }
        if (!response.ok) {
          drop(fork);
          throw new RestCommitPartial(
            `${fork.operation} may have been committed: the server answered ${response.status} to the batch, which does not say whether it applied it`,
            { acknowledged: [], unknown: writes[0]!.ref, unsent: writes.slice(1).map((w) => w.ref) },
          );
        }
        const body = (await response.json()) as {
          acknowledged?: Array<{ path: string; etag?: string; version?: unknown }>;
        };
        for (const write of writes) {
          const answered = body.acknowledged?.find((entry) => entry.path === write.path);
          const version =
            answered?.etag ??
            (answered?.version === undefined ? undefined : String(answered.version));
          acknowledge(write.ref, version ?? write.ifMatch);
        }
        drop(fork);
        return fork.result;
      }

      // One request per row, in the order the operation wrote them. The
      // first refusal stops the rest; what was already acknowledged stays
      // acknowledged, because REST has nothing to roll it back with.
      for (const [index, write] of writes.entries()) {
        const unsent = writes.slice(index + 1).map((w) => w.ref);
        let response: Response;
        try {
          response = await request(write.path, {
            method: "PUT",
            headers: { "content-type": "application/json", "if-match": write.ifMatch },
            body: JSON.stringify(write.body),
          });
        } catch (err) {
          drop(fork);
          throw new RestCommitPartial(
            `${fork.operation} may have been committed in part: ${describe(fork.acknowledged)}; ${name(
              write.ref,
            )} was sent and its answer was lost (${
              err instanceof Error ? err.message : String(err)
            })${unsent.length > 0 ? `; not sent: ${unsent.map(name).join(", ")}` : ""}`,
            { acknowledged: [...fork.acknowledged], unknown: write.ref, unsent },
          );
        }
        if (response.status === 412 && fork.acknowledged.length === 0) {
          stale(fork, [write.ref]);
        }
        if (!response.ok) {
          drop(fork);
          throw new RestCommitPartial(
            `${fork.operation} was committed in part: ${describe(fork.acknowledged)}; ${name(
              write.ref,
            )} was refused with ${response.status}${
              unsent.length > 0 ? `; not sent: ${unsent.map(name).join(", ")}` : ""
            }`,
            { acknowledged: [...fork.acknowledged], refused: write.ref, unsent },
          );
        }
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        acknowledge(write.ref, versionIn(write.source.version, response, body) ?? write.ifMatch);
      }
      drop(fork);
      return fork.result;
    },

    release: (fork) => {
      drop(fork);
    },

    // Whatever the human found, the fork is finished; the server was never
    // asked to hold anything for it.
    reconcile: (fork) => {
      drop(fork);
    },

    identify: (fork) => ({ fork: fork.id, operation: fork.operation, input: fork.input }),

    /**
     * The fork under the id a record kept, or an empty fork under that id
     * when this process never held it. Nothing about a fork lives on the
     * server, so after a reload the name is all there is, and a person
     * settling the record needs the name.
     */
    resolveArtifact: (record) => {
      if (record.artifact.kind !== "reference") {
        return undefined;
      }
      const reference = record.artifact.reference as
        | { fork?: unknown; operation?: unknown; input?: unknown }
        | null;
      const id = reference?.fork;
      const operation = reference?.operation;
      if (typeof id !== "string" || typeof operation !== "string") {
        return undefined;
      }
      const declared = options.operations[operation];
      if (declared === undefined) {
        return undefined;
      }
      const input =
        typeof reference?.input === "object" && reference.input !== null
          ? (reference.input as Record<string, unknown>)
          : {};
      return (
        forks.get(id) ?? {
          id,
          operation,
          input,
          base: [],
          head: [],
          result: undefined,
          run: declared.run,
          acknowledged: [],
          settled: false,
        }
      );
    },
  };

  return adapter;
}

function describe(acknowledged: readonly RestAcknowledged[]): string {
  return acknowledged.length === 0
    ? "nothing was acknowledged"
    : `acknowledged: ${acknowledged.map((row) => `${name(row)} at ${row.version}`).join(", ")}`;
}

function forkId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  return random === undefined
    ? `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    : random.call(globalThis.crypto);
}
