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
};

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

  constructor(operation: string, changes: readonly Change[], reason: unknown) {
    super(
      `${operation} threw while committing, so whether the change landed is unknown: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    this.name = "StagedCommitIndeterminate";
    this.changes = changes;
    this.reason = reason;
  }
}

/**
 * A staged artifact that could not be disposed. Invoking a hook that throws
 * is an attempted cleanup, not a completed one, so the artifact is still open
 * in the application and has to stay findable.
 */
export type CleanupFailure = { operation: string; detail: string };

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

    const changes: readonly Change[] = derived;
    let settled = false;
    return {
      changes,
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
          throw new StagedCommitIndeterminate(operation, changes, err);
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
  capability: string;
  kind: "commit_indeterminate" | "cleanup_failed";
  detail: string;
  /** What the human approved, kept as the thing to reconcile against. */
  changes: readonly Change[];
  at: number;
};

export class UnreconciledStore {
  private readonly entries: Unreconciled[] = [];
  private nextId = 1;

  record(entry: Omit<Unreconciled, "id">): Unreconciled {
    const stored: Unreconciled = { ...entry, id: `UNREC-${this.nextId++}` };
    this.entries.push(stored);
    return stored;
  }

  list(): Unreconciled[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Binds a record to the approval it belongs to, once one is known. */
  attachAction(id: string, actionId: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) {
      entry.actionId = actionId;
    }
  }

  /** The open record for an approval, if it has one. */
  forAction(actionId: string): Unreconciled | undefined {
    return this.entries.find((entry) => entry.actionId === actionId);
  }

  settle(id: string): Unreconciled | undefined {
    const index = this.entries.findIndex((entry) => entry.id === id);
    return index === -1 ? undefined : this.entries.splice(index, 1)[0];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
