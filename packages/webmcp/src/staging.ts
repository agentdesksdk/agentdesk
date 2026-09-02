import { deepFreeze } from "./audit.ts";
import { CapabilityUnavailableError, type Change } from "./capability.ts";
import type { Actor } from "./plan.ts";

/**
 * How an application stages, describes, and lands its own writes.
 *
 * Bound once, at `createAgentDeskRuntime`, and it owns the operations too. A
 * capability names one and supplies input; it never hands over executable
 * code, so nothing a capability declares can reach live state outside a fork.
 * The diff a human approves and the write that lands are both derived by the
 * runtime from the single opaque `S` this adapter produced, and `S` is never
 * inspected by the runtime.
 *
 * This is a trusted boundary and it is one per application. An adapter whose
 * `diff` disagrees with its `commit`, or whose operation writes outside its
 * own fork, can still lie. Placing all of it here makes that a single audited
 * integration point chosen at composition time rather than per-operation code.
 */
/** What a fork produces: the adapter's artifact and the operation's result. */
export type Forked<S> = { staged: S; result: unknown };

export type StagingAdapter<S> = {
  /**
   * Names this adapter is willing to stage. Checked at `start`, so a
   * capability naming an operation that does not exist is refused before an
   * operator can be shown a card for it.
   */
  operations: ReadonlySet<string> | readonly string[];
  /**
   * Runs a sequence of stagings so each derives against its predecessor's
   * staged head rather than against live state. Plan preparation needs this;
   * a plan whose second operation previews against live state shows the
   * human a plan that will not happen.
   */
  scope: <T>(run: () => T) => T;
  /**
   * Stages `operation` with `input` against a fork of live state. `previous`
   * is the artifact of an earlier run of the same operation, so an adapter
   * that pins a clock or a seed can reproduce it rather than drift.
   */
  fork: (
    operation: string,
    input: Record<string, unknown>,
    previous?: S,
  ) => Forked<S> | Promise<Forked<S>>;
  /** What this staged run did. The only source of a `derived` diff. */
  diff: (staged: S) => Change[];
  /**
   * Lands the staged run. `restage` re-runs the same operation on a fresh
   * fork for an adapter that must re-derive against current state.
   *
   * Returns the result, or a promise of it for a store that answers later.
   * The runtime awaits it before recording the outcome, so a completion is
   * never audited for a write the store then rolled back.
   *
   * Throwing, or rejecting, refuses the commit. It does not prove the write
   * did not land, so the runtime treats it as indeterminate rather than a
   * clean failure. An adapter that knows nothing was dispatched says so
   * with `StagedCommitRefused` or `CapabilityUnavailableError`, thrown or
   * rejected with. Both mean the commit stopped before it wrote, which only
   * the adapter can establish.
   */
  commit: (
    staged: S,
    restage: () => Forked<S> | Promise<Forked<S>>,
  ) => unknown;
  /**
   * Releases a staged run that will never land. Called at most once, and
   * only a successful return, or a promise that resolves, establishes
   * disposal; a rejection is a failed cleanup like a throw is.
   */
  release: (staged: S) => void | Promise<void>;
  /**
   * Settles an artifact a human has gone and looked at.
   *
   * Called with the artifact the runtime retained and what the human found.
   * A successful return is what makes the artifact terminal; throwing leaves
   * the record open with its evidence, because an unresolved external
   * condition is not resolved by failing to resolve it.
   */
  reconcile: (staged: S, resolution: StagedResolution) => void;
  /**
   * A durable key for an artifact that cannot be cloned, so a record of an
   * unknown commit can name its artifact across a restart and the
   * application's `resolveArtifact` can rebuild it. Optional; an adapter
   * whose artifacts clone needs none.
   */
  identify?: (staged: S) => unknown;
};

/**
 * What a human found, and therefore what the adapter should do about it.
 *
 * Commit application and cleanup disposal are separate questions. Whether a
 * write landed says nothing about whether a failed release later succeeded,
 * so they do not share a vocabulary.
 */
export type StagedResolution =
  /** The write did reach the application. The fork is moot; drop it. */
  | { kind: "commit_applied" }
  /** The write never reached the application. The fork is moot; drop it. */
  | { kind: "commit_not_applied" }
  /** A disposal that had failed has now succeeded. */
  | { kind: "cleanup_disposed" };

/**
 * Which resolutions can settle which record.
 *
 * Whether a write landed and whether a failed disposal later succeeded are
 * different questions, so answering one of them about the other is a
 * contradiction rather than a choice.
 */
const RESOLVES: Record<Unreconciled["kind"], ReadonlySet<string>> = {
  commit_indeterminate: new Set(["commit_applied", "commit_not_applied"]),
  cleanup_failed: new Set(["cleanup_disposed"]),
};

/**
 * Parses a resolution arriving from a JavaScript caller and checks it against
 * the record it claims to settle.
 */
export function parseResolution(
  kind: Unreconciled["kind"],
  resolution: unknown,
): { ok: true; resolution: StagedResolution } | { ok: false; reason: string } {
  if (
    typeof resolution !== "object" ||
    resolution === null ||
    Array.isArray(resolution)
  ) {
    return { ok: false, reason: "a resolution must be an object" };
  }
  const keys = Object.keys(resolution);
  if (keys.length !== 1 || keys[0] !== "kind") {
    return {
      ok: false,
      reason: `a resolution carries only a kind, not ${keys.join(", ")}`,
    };
  }
  const value = (resolution as { kind: unknown }).kind;
  if (typeof value !== "string") {
    return { ok: false, reason: "a resolution kind must be a string" };
  }
  if (!RESOLVES[kind].has(value)) {
    return {
      ok: false,
      reason: `${value} cannot settle a ${kind} record; it accepts ${[
        ...RESOLVES[kind],
      ].join(" or ")}`,
    };
  }
  return { ok: true, resolution: { kind: value } as StagedResolution };
}

/**
 * The digest an approval is bound to.
 *
 * It covers the state the preview was derived from and nothing else: each
 * change's field and its `before` value, in field order. That is the set of
 * facts a person read when they approved, so a write to anything outside it
 * leaves the digest intact and a write to anything inside it changes it.
 * Digesting the whole store instead would fire a stale approval on every
 * unrelated write, and a stale approval that fires on unrelated writes
 * teaches people to re-approve without reading.
 *
 * `after` is deliberately not covered. A capability whose output depends on
 * a clock or a counter produces a different `after` from the same state, and
 * that is not drift. What the human authorized is a change *from* this
 * state; the runtime re-derives the change at commit and compares the from.
 *
 * One function for single approvals and for plans, so the two cannot drift
 * apart on what "the same state" means. Nothing an author or an adapter
 * returns reaches it except `field` and `before`, so a digest they hand in
 * on a change is ignored rather than trusted.
 */
export function stateDigest(changes: readonly Change[]): string {
  const facts = [...changes]
    .map((change) => [change.field, canonical(change.before)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, before]) => `${JSON.stringify(field)}:${before}`)
    .join("|");
  return `sv-${fnv1a(facts, 0x811c9dc5)}${fnv1a(facts, 0x01000193)}`;
}

/**
 * A digest of any plain value, stable across property order. The seal on a
 * persisted record is one of these over its evidence fields, so a record
 * that comes back changed is refused rather than trusted.
 */
export function digestOf(value: unknown): string {
  const text = canonical(value);
  return `dg-${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x01000193)}`;
}

/** Stable across property insertion order; `undefined` is spelled out. */
function canonical(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A capability's proposed write. Built by the runtime from one staged
 * artifact, never assembled by a capability author, which is what entitles
 * it to `approvalEvidence: "derived"`.
 */
export type StagedProposal = {
  /** What the staged run did, read off the fork. */
  readonly changes: readonly Change[];
  /** Lands the staged write. The runtime calls this at most once. */
  readonly commit: () => unknown;
  /** Throws the staged write away. Safe to call more than once. */
  readonly discard: () => void;
  /**
   * The adapter's own artifact. Opaque to the runtime, which only hands it
   * back to the adapter, and retained so an artifact left open by a failed
   * commit or a failed disposal can still be settled later.
   */
  readonly artifact: unknown;
};

/** Internal. Produced only by `buildStageHandler`. */
export type StageHandler = (input: Record<string, unknown>) => StagedProposal;

export class StagedProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedProposalError";
  }
}

/**
 * Thrown by an adapter that knows its commit never reached the application.
 * Only an adapter can know that, so it is the one thing that turns a thrown
 * commit back into an ordinary failure.
 */
export class StagedCommitRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedCommitRefused";
  }
}

/**
 * A commit that threw after it may already have written.
 *
 * The exception proves the adapter did not return, not that nothing landed.
 * The approved diff rides along so a human has something to reconcile
 * against, and the artifact is deliberately not released.
 */
export class StagedCommitIndeterminate extends Error {
  readonly changes: readonly Change[];
  readonly reason: unknown;
  /** The artifact to hand back to the adapter once a human has looked. */
  readonly artifact: unknown;

  constructor(
    operation: string,
    changes: readonly Change[],
    reason: unknown,
    artifact: unknown,
  ) {
    super(
      `${operation} threw while committing, so whether the change landed is unknown: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    this.name = "StagedCommitIndeterminate";
    this.changes = changes;
    this.reason = reason;
    this.artifact = artifact;
  }
}

/**
 * A staged artifact that could not be disposed. Invoking a hook that throws
 * is an attempted cleanup, not a completed one, so the artifact is still open
 * in the application and has to stay findable.
 */
export type CleanupFailure = {
  operation: string;
  detail: string;
  /** The artifact the failed disposal left open. */
  artifact: unknown;
};

export type StageHooks = {
  /** Called when `release` throws, so the runtime records and retains it. */
  cleanupFailed: (failure: CleanupFailure) => void;
};

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    typeof (value as PromiseLike<unknown> | null)?.then === "function"
  );
}

/**
 * Builds the staged proposal the runtime owns.
 *
 * The capability supplies neither the diff, nor the commit, nor the write, so
 * the evidence a human approves is derived here from the same artifact that
 * lands.
 */
export function buildStageHandler<S>(
  operation: string,
  adapter: StagingAdapter<S>,
  hooks: StageHooks,
): StageHandler {
  const tryRelease = (staged: S): void => {
    const failed = (err: unknown): void =>
      hooks.cleanupFailed({
        operation,
        detail: err instanceof Error ? err.message : String(err),
        artifact: staged,
      });
    try {
      const outcome: unknown = adapter.release(staged);
      if (isThenable(outcome)) {
        (outcome as Promise<void>).then(undefined, failed);
      }
    } catch (err) {
      failed(err);
    }
  };

  // A cleanup that fails must not replace the reason staging failed, which is
  // what a human has to read, but it must not vanish either.
  const releaseAndRethrow = (staged: S, cause: unknown): never => {
    tryRelease(staged);
    throw cause;
  };

  const stageOnce = (input: Record<string, unknown>, previous?: S) => {
    // stub: a promise from fork flows through as if it were the artifact
    const forked = adapter.fork(operation, input, previous) as Forked<S>;
    if (isThenable(forked?.result)) {
      (forked.result as Promise<unknown>).catch?.(() => {});
      releaseAndRethrow(
        forked.staged,
        new StagedProposalError(
          `${operation} staged asynchronously. A staged operation must finish before it returns, because its writes go to a fork that closes when it does.`,
        ),
      );
    }
    return forked;
  };

  return (input) => {
    const forked = stageOnce(input);

    let derived: Change[] | undefined;
    try {
      derived = adapter.diff(forked.staged);
    } catch (err) {
      releaseAndRethrow(forked.staged, err);
    }
    if (!Array.isArray(derived)) {
      return releaseAndRethrow(
        forked.staged,
        new StagedProposalError(
          `${operation} staged a change the adapter could not describe.`,
        ),
      );
    }

    // Detached here, before anything is dispatched. Evidence that cannot be
    // recorded has to be refused while refusing is still free; discovering it
    // inside the catch after a commit would lose the record of a write that
    // may already have landed.
    let changes: readonly Change[];
    try {
      changes = deepFreeze(structuredClone(derived)) as readonly Change[];
    } catch (err) {
      return releaseAndRethrow(
        forked.staged,
        new StagedProposalError(
          `${operation} staged a change that cannot be recorded as evidence, so it was refused before it ran: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    let settled = false;
    return {
      changes,
      artifact: forked.staged,
      commit: () => {
        if (settled) {
          throw new StagedProposalError(
            `${operation} staged a change that was already settled`,
          );
        }
        settled = true;
        // Only the adapter can know the write never reached the
        // application. Anything else may have landed, so the artifact is
        // kept rather than released and the outcome stays unknown. A
        // rejection is read exactly as a throw is.
        const classify = (err: unknown): never => {
          if (
            err instanceof StagedCommitRefused ||
            err instanceof CapabilityUnavailableError
          ) {
            releaseAndRethrow(forked.staged, err);
          }
          throw new StagedCommitIndeterminate(
            operation,
            changes,
            err,
            forked.staged,
          );
        };
        let outcome: unknown;
        try {
          outcome = adapter.commit(forked.staged, () =>
            stageOnce(input, forked.staged),
          );
        } catch (err) {
          classify(err);
        }
        return isThenable(outcome)
          ? (outcome as Promise<unknown>).then((value) => value, classify)
          : outcome;
      },
      discard: () => {
        if (settled) {
          return;
        }
        settled = true;
        tryRelease(forked.staged);
      },
    };
  };
}

/**
 * Live staged proposals, keyed by the runtime identity that owns each one.
 *
 * A single approval owns its proposal under the pending action's id; a plan
 * operation owns one under the plan id and its position. Nothing is keyed by
 * business input, so two approvals for the same capability and input hold
 * two distinct proposals and neither can consume or overwrite the other.
 */
export class StagedProposalStore {
  private readonly proposals = new Map<string, StagedProposal>();

  static planKey(planId: string, index: number): string {
    return `${planId}#${index}`;
  }

  put(key: string, proposal: StagedProposal): void {
    this.discard(key);
    this.proposals.set(key, proposal);
  }

  has(key: string): boolean {
    return this.proposals.has(key);
  }

  /** Hands the proposal to a caller that will commit it. */
  take(key: string): StagedProposal | undefined {
    const proposal = this.proposals.get(key);
    this.proposals.delete(key);
    return proposal;
  }

  /**
   * Terminal disposal. A proposal whose owner resolved any other way than a
   * commit is thrown away here, so a rejected change stops being visible and
   * a stranded fork stops being reachable.
   */
  discard(key: string): void {
    const proposal = this.proposals.get(key);
    if (!proposal) {
      return;
    }
    this.proposals.delete(key);
    proposal.discard();
  }

  discardPlan(planId: string): void {
    for (const key of [...this.proposals.keys()]) {
      if (key.startsWith(`${planId}#`)) {
        this.discard(key);
      }
    }
  }

  discardAll(): void {
    for (const key of [...this.proposals.keys()]) {
      this.discard(key);
    }
  }

  size(): number {
    return this.proposals.size;
  }
}

/**
 * A staged outcome nobody can call settled.
 *
 * Either a commit threw after it may have written, or a disposal failed and
 * left the artifact open in the application. Both need a person, so they stay
 * listed until one says what happened.
 */
export type Unreconciled = {
  id: string;
  /** The approval this belongs to, when it had one. */
  actionId?: string;
  /** The plan and position this belongs to, when it came from one. */
  planId?: string;
  operationIndex?: number;
  capability: string;
  /**
   * Capability plus input fingerprint. An unresolved commit under this key
   * blocks the same call being made again, because a repeat would apply a
   * change that may already have landed.
   */
  operationKey?: string;
  kind: "commit_indeterminate" | "cleanup_failed";
  detail: string;
  /** What the human approved, kept as the thing to reconcile against. */
  changes: readonly Change[];
  /** Who ran the capability whose commit became unknown. */
  executedBy?: Actor;
  /** The state digest the approval was bound to, when it had one. */
  stateVersion?: string;
  /** The grant that authorized the execution, when one did. */
  grantId?: string;
  at: number;
};

/**
 * Staged outcomes nobody can call settled.
 *
 * Either a commit threw after it may have written, or a disposal failed and
 * left the artifact open in the application. Both need a person, so they stay
 * listed until one goes and looks and the adapter settles the artifact.
 *
 * The adapter's artifact is held here and never handed out. Reads return
 * detached, deeply frozen copies, because this is the evidence a human
 * reconciles against and a caller that could edit it could rewrite what the
 * runtime says happened.
 *
 * In-memory, and nothing here survives a restart. A persisted audit stream
 * proves an incident happened and no more: `execution_indeterminate` and
 * `staged_cleanup_failed` carry the record id, the capability, the detail,
 * and the time. They do not carry `changes`, `operationKey`, `actionId`,
 * `planId`, `operationIndex`, or the artifact. `hydrate` is how a
 * persistence adapter puts a full record back.
 *
 * Both halves are lost, and they hurt differently. Without the record,
 * `listUnreconciled` is empty and `operationKey` is gone with it, so the
 * guard that refuses a repeat is gone too and the same call can be
 * dispatched again. Without the artifact, `reconcile` has nothing to hand
 * the adapter, so the incident cannot be closed at all.
 *
 * Production durability therefore needs three things, not one: durable
 * storage for the records, a hydration API that can replay them into this
 * store, and adapter artifacts addressable by a durable key rather than by
 * object identity. That is application work an embedded runtime with no
 * backend cannot do for itself.
 */
export class UnreconciledStore {
  private readonly entries: Array<{
    record: Unreconciled;
    artifact: unknown;
  }> = [];
  private nextId = 1;

  /**
   * Puts a record back that a persistence adapter loaded. The id is the one
   * it was saved under, so an approval's `actionId` and a plan's key still
   * find it, and the counter moves past it so a new record cannot collide.
   * A record already present, as after a stop and a second start of the
   * same runtime, is left alone.
   */
  hydrate(record: Unreconciled, artifact: unknown): boolean {
    if (this.entries.some((entry) => entry.record.id === record.id)) {
      return false;
    }
    const stored = deepFreeze(structuredClone(record)) as Unreconciled;
    this.entries.push({ record: stored, artifact });
    const suffix = Number(record.id.replace(/^UNREC-/, ""));
    if (Number.isInteger(suffix) && suffix >= this.nextId) {
      this.nextId = suffix + 1;
    }
    return true;
  }

  /**
   * Never throws. Evidence is detached at the staging boundary, before
   * anything is dispatched, so by here it is already cloneable. This is
   * called after a write may have landed, and throwing would lose the only
   * record of it, so the detached evidence is reused if cloning fails
   * anyway.
   */
  record(entry: Omit<Unreconciled, "id">, artifact: unknown): Unreconciled {
    const id = `UNREC-${this.nextId++}`;
    let stored: Unreconciled;
    try {
      stored = deepFreeze({
        ...structuredClone({ ...entry, changes: [...entry.changes] }),
        id,
      }) as Unreconciled;
    } catch {
      stored = deepFreeze({ ...entry, id }) as Unreconciled;
    }
    this.entries.push({ record: stored, artifact });
    return stored;
  }

  list(): Unreconciled[] {
    return this.entries.map(({ record }) => deepFreeze(structuredClone(record)));
  }

  /** Binds a record to the approval it belongs to, once one is known. */
  attach(id: string, owner: Partial<Unreconciled>): void {
    const found = this.entries.find(({ record }) => record.id === id);
    if (found) {
      found.record = deepFreeze({ ...found.record, ...owner }) as Unreconciled;
    }
  }

  /** An unresolved unknown commit for this exact call, if there is one. */
  forOperation(operationKey: string): Unreconciled | undefined {
    const found = this.entries.find(
      ({ record }) =>
        record.kind === "commit_indeterminate" &&
        record.operationKey === operationKey,
    );
    return found ? deepFreeze(structuredClone(found.record)) : undefined;
  }

  /** The open record for an approval, if it has one. */
  forAction(actionId: string): Unreconciled | undefined {
    const found = this.entries.find(
      ({ record }) => record.actionId === actionId,
    );
    return found ? deepFreeze(structuredClone(found.record)) : undefined;
  }

  /** The record and its artifact, for the runtime to hand to the adapter. */
  open(id: string): { record: Unreconciled; artifact: unknown } | undefined {
    const found = this.entries.find(({ record }) => record.id === id);
    return found ? { record: found.record, artifact: found.artifact } : undefined;
  }

  /**
   * Removes a record. Only called once the adapter has settled its artifact,
   * because deleting the record of an open artifact loses the one thing that
   * could still find it.
   */
  settle(id: string): Unreconciled | undefined {
    const index = this.entries.findIndex(({ record }) => record.id === id);
    return index === -1 ? undefined : this.entries.splice(index, 1)[0]!.record;
  }

  size(): number {
    return this.entries.length;
  }
}
