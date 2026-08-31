import type { Change, ExecutionContext } from "./capability.ts";

/**
 * How an application forks, diffs, and lands its own state.
 *
 * Bound once, at `createAgentDeskRuntime`. A capability declares only its
 * write and cannot reach this, so the author of an operation cannot describe
 * one change and perform another; both the diff a human approves and the
 * commit that lands come from the single opaque `S` this adapter produced.
 * `S` is never inspected by the runtime.
 *
 * This is a trusted boundary, and it is one per application rather than one
 * per capability. An adapter whose `diff` disagrees with its `commit` can
 * still lie; nothing below the application's own data layer can prevent
 * that. Placing it here makes it a single audited integration point.
 */
export type StagingAdapter<S> = {
  /**
   * Runs a sequence of stagings so each derives against its predecessor's
   * staged head rather than against live state. Plan preparation needs this;
   * a plan whose second operation previews against live state shows the
   * human a plan that will not happen.
   */
  scope: <T>(run: () => T) => T;
  /**
   * Runs `write` against a fork of live state. `previous` is the artifact of
   * an earlier run of the same operation, so an adapter that pins a clock or
   * a seed can reproduce it rather than drift.
   */
  fork: (
    capability: string,
    write: () => unknown,
    previous?: S,
  ) => { staged: S; result: unknown };
  /** What this staged run did. The only source of a `derived` diff. */
  diff: (staged: S) => Change[];
  /**
   * Lands the staged run. `restage` re-runs the same write on a fresh fork
   * for an adapter that must re-derive against current state. Throwing
   * refuses the commit and lands nothing.
   */
  commit: (staged: S, restage: () => { staged: S; result: unknown }) => unknown;
  /** Releases a staged run that will never land. Called at most once. */
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
export type StageHandler = (
  input: Record<string, unknown>,
  ctx: ExecutionContext,
) => StagedProposal;

/**
 * The handler a capability author writes. Synchronous by contract, because a
 * handler that suspends resumes after its fork has closed and its remaining
 * writes would reach live state before anyone approved them.
 */
export type StagedWrite = (
  input: Record<string, unknown>,
  ctx: ExecutionContext,
) => unknown;

export class StagedProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedProposalError";
  }
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    typeof (value as PromiseLike<unknown> | null)?.then === "function"
  );
}

/**
 * Releases an artifact that will never be committed, then rethrows what went
 * wrong. A cleanup that fails must not replace the reason staging failed,
 * which is the thing a human has to read.
 */
function releaseAndRethrow<S>(
  adapter: StagingAdapter<S>,
  staged: S,
  cause: unknown,
): never {
  try {
    adapter.release(staged);
  } catch {
    // Reported through the original failure below rather than thrown over
    // it. A cleanup error is a diagnosis; the staging error is the outcome.
  }
  throw cause;
}

/**
 * Turns an application adapter and a capability's write into the staged
 * proposal the runtime owns.
 *
 * The author supplies neither `changes` nor `commit`. Both are derived here
 * from the same `staged` artifact, so the diff on the approval card and the
 * change that lands cannot come from two different places.
 */
export function buildStageHandler<S>(
  name: string,
  adapter: StagingAdapter<S>,
  write: StagedWrite,
): StageHandler {
  const stageOnce = (
    input: Record<string, unknown>,
    ctx: ExecutionContext,
    previous?: S,
  ) => {
    const forked = adapter.fork(name, () => write(input, ctx), previous);
    if (isThenable(forked?.result)) {
      (forked.result as Promise<unknown>).catch?.(() => {});
      releaseAndRethrow(
        adapter,
        forked.staged,
        new StagedProposalError(
          `${name} staged asynchronously. A staged handler must finish before it returns, because its writes go to a fork that closes when it does.`,
        ),
      );
    }
    return forked;
  };

  return (input, ctx) => {
    const forked = stageOnce(input, ctx);

    let changes: readonly Change[];
    try {
      changes = adapter.diff(forked.staged);
    } catch (err) {
      releaseAndRethrow(adapter, forked.staged, err);
    }
    if (!Array.isArray(changes)) {
      releaseAndRethrow(
        adapter,
        forked.staged,
        new StagedProposalError(
          `${name} staged a change the adapter could not describe.`,
        ),
      );
    }

    // Settled only once the artifact has actually been handed to `commit` or
    // `release`. Marking it before the call let a throwing commit leave the
    // artifact open with the later discard skipping it as already settled.
    let settled = false;
    return {
      changes,
      commit: () => {
        if (settled) {
          throw new StagedProposalError(
            `${name} staged a change that was already settled`,
          );
        }
        settled = true;
        try {
          return adapter.commit(forked.staged, () =>
            stageOnce(input, ctx, forked.staged),
          );
        } catch (err) {
          releaseAndRethrow(adapter, forked.staged, err);
        }
      },
      discard: () => {
        if (settled) {
          return;
        }
        settled = true;
        adapter.release(forked.staged);
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
