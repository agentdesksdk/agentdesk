import { deepFreeze } from "./audit.ts";
import { CapabilityUnavailableError, type Change } from "./capability.ts";

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
  ) => { staged: S; result: unknown };
  /** What this staged run did. The only source of a `derived` diff. */
  diff: (staged: S) => Change[];
  /**
   * Lands the staged run. `restage` re-runs the same operation on a fresh
   * fork for an adapter that must re-derive against current state.
   *
   * Throwing refuses the commit. It does not prove the write did not land,
   * so the runtime treats it as indeterminate rather than a clean failure.
   *
   * An adapter that knows nothing was dispatched says so by throwing
   * `StagedCommitRefused` or `CapabilityUnavailableError`. Both mean the
   * commit stopped before it wrote, which only the adapter can establish.
   */
  commit: (staged: S, restage: () => { staged: S; result: unknown }) => unknown;
  /**
   * Releases a staged run that will never land. Called at most once, and
   * only a successful return establishes disposal.
   */
  release: (staged: S) => void;
  /**
   * Settles an artifact a human has gone and looked at.
   *
   * Called with the artifact the runtime retained and what the human found.
   * A successful return is what makes the artifact terminal; throwing leaves
   * the record open with its evidence, because an unresolved external
   * condition is not resolved by failing to resolve it.
   */
  reconcile: (staged: S, resolution: StagedResolution) => void;
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
    try {
      adapter.release(staged);
    } catch (err) {
      hooks.cleanupFailed({
        operation,
        detail: err instanceof Error ? err.message : String(err),
        artifact: staged,
      });
    }
  };

  // A cleanup that fails must not replace the reason staging failed, which is
  // what a human has to read, but it must not vanish either.
  const releaseAndRethrow = (staged: S, cause: unknown): never => {
    tryRelease(staged);
    throw cause;
  };

  const stageOnce = (input: Record<string, unknown>, previous?: S) => {
    const forked = adapter.fork(operation, input, previous);
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
        try {
          return adapter.commit(forked.staged, () =>
            stageOnce(input, forked.staged),
          );
        } catch (err) {
          // Only the adapter can know the write never reached the
          // application. Anything else may have landed, so the artifact is
          // kept rather than released and the outcome stays unknown.
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
        }
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
 * In-memory, and this one does not survive a restart in the way the others
 * do. The records themselves are reconstructible from the audit stream,
 * which carries `execution_indeterminate` and `staged_cleanup_failed` with
 * their record ids and detail. The artifact is not: it is a live object the
 * adapter made, so after a process or page restart a human can still learn
 * that a write may have landed but can no longer call `reconcile` on it.
 *
 * That is a real limitation of an embedded runtime with no backend, and it
 * is the work an application has to do before this is production-stable.
 * An adapter whose artifacts are addressable by a durable key, rather than
 * by object identity, can rehydrate them and close the gap.
 */
export class UnreconciledStore {
  private readonly entries: Array<{
    record: Unreconciled;
    artifact: unknown;
  }> = [];
  private nextId = 1;

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
