import type { Change, ExecutionContext } from "./capability.ts";

/**
 * A capability's proposed write, produced by running that capability's own
 * handler against a fork of application state.
 *
 * The runtime owns the artifact from the moment it is created until it is
 * committed or discarded. Preview and commit are one execution rather than
 * two descriptions of one, so the diff a human approved and the change that
 * lands cannot disagree.
 */
export type StagedProposal = {
  /** What the staged run did, read off the fork. */
  readonly changes: readonly Change[];
  /** Lands the staged write. The runtime calls this at most once. */
  readonly commit: () => unknown;
  /** Throws the staged write away. Safe to call more than once. */
  readonly discard: () => void;
};

/**
 * Produces a proposal without touching live state.
 *
 * Synchronous by contract. A handler that suspends resumes after the fork
 * has closed, and its remaining writes would land on live state before
 * anyone approved them. `defineCapability` refuses an async function and
 * `runStage` refuses a thenable, because a check after the fact cannot undo
 * a continuation that already escaped.
 */
export type StageHandler = (
  input: Record<string, unknown>,
  ctx: ExecutionContext,
) => StagedProposal;

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

/**
 * Calls a stage handler and refuses a result that is not a finished
 * proposal. An async handler is rejected at definition time; this catches a
 * plain function that hands back a promise anyway.
 */
export function runStage(
  name: string,
  stage: StageHandler,
  input: Record<string, unknown>,
  ctx: ExecutionContext,
): StagedProposal {
  const proposal = stage(input, ctx) as StagedProposal | PromiseLike<unknown>;
  if (proposal !== null && typeof (proposal as PromiseLike<unknown>)?.then === "function") {
    throw new StagedProposalError(
      `${name} staged asynchronously. A staged handler must finish before it returns, because its writes go to a fork that closes when it does.`,
    );
  }
  const candidate = proposal as StagedProposal;
  if (
    typeof candidate?.commit !== "function" ||
    typeof candidate?.discard !== "function" ||
    !Array.isArray(candidate?.changes)
  ) {
    throw new StagedProposalError(
      `${name} did not return a staged proposal with changes, commit, and discard.`,
    );
  }
  return candidate;
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
