import type { Change, ExecutionContext } from "./capability.ts";

/**
 * How an application forks, diffs, and lands its own state.
 *
 * One adapter per application, not one per capability. The capability author
 * writes only the handler; the changes a human approves and the commit that
 * lands them are both derived by the runtime from the single opaque `S` this
 * adapter produced, so a capability cannot display one diff and perform a
 * different write. `S` is never inspected by the runtime.
 */
export type StagingAdapter<S> = {
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

/**
 * Runs a sequence of stagings so each derives against its predecessor's
 * staged head rather than against live state.
 *
 * Plan preparation requires one. A plan whose second operation previews
 * against live state shows the human a plan that will not happen, because by
 * then the first operation has already run.
 */
export type StagingScope = <T>(run: () => T) => T;

export class StagedProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedProposalError";
  }
}

function refuseThenable(name: string, value: unknown): void {
  if (
    value !== null &&
    typeof (value as PromiseLike<unknown> | null)?.then === "function"
  ) {
    (value as Promise<unknown>).catch?.(() => {});
    throw new StagedProposalError(
      `${name} staged asynchronously. A staged handler must finish before it returns, because its writes go to a fork that closes when it does.`,
    );
  }
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
    refuseThenable(name, forked?.result);
    return forked;
  };

  return (input, ctx) => {
    const forked = stageOnce(input, ctx);
    const changes = adapter.diff(forked.staged);
    if (!Array.isArray(changes)) {
      throw new StagedProposalError(
        `${name} staged a change the adapter could not describe.`,
      );
    }
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
        return adapter.commit(forked.staged, () =>
          stageOnce(input, ctx, forked.staged),
        );
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
