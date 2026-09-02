import {
  CapabilityUnavailableError,
  unavailable,
  type Change,
  type Forked,
  type StagingAdapter,
} from "@agentdesk/webmcp";
import {
  deriveChanges,
  deriveEntries,
  mergeBranch,
  type MergeConflict,
} from "../data/branch.ts";
import {
  getCommittedState,
  land,
  onReset,
  stage,
  stagingScope,
} from "../data/store.ts";
import type { Branch, DemoState } from "../data/types.ts";

/**
 * How an approved branch reaches the live document.
 *
 * `merge` lands the staged writes themselves, so the operation the human
 * approved is literally the one that runs and the handler executes once.
 * `rederive` re-runs the handler against current state at approval time and
 * compares. Use it when the output depends on state the human might move,
 * such as an id derived from a collection's length.
 *
 * Both refuse rather than land a partial change. A human who approved a diff
 * gets that diff or gets asked again; there is no third outcome where some of
 * it applied.
 */
export type CommitMode = "merge" | "rederive";

/**
 * One staged run of one capability.
 *
 * Opaque to the runtime, which never reads it. The changes on the approval
 * card and the write that lands are both derived from this single object, so
 * a capability cannot show one diff and perform another.
 */
export type StagedBranch = {
  readonly capability: string;
  readonly mode: CommitMode;
  readonly branch: Branch;
  /** The input the handler ran with, so the fork can be rebuilt by name. */
  readonly input: Record<string, unknown>;
  /**
   * The registered operation this branch came from. A function, so the
   * artifact does not clone: a persisted record keeps the identity below
   * rather than two copies of the document, and `rebuildBranch` re-stages.
   */
  readonly operation: Operation;
  /** What the handler returned, carried so the commit hands back its receipt. */
  readonly result: unknown;
  settled: boolean;
};

/** What a persisted record keeps of a fork: enough to stage it again. */
export type BranchIdentity = {
  capability: string;
  input: Record<string, unknown>;
  at: number;
};

/**
 * Branches that exist right now.
 *
 * A branch joins on fork and leaves on commit or release, and the runtime
 * owns both ends, so this set is exactly the set of changes a human could
 * still approve. Rejecting an action removes its ghost because the runtime
 * released the artifact, not because the UI remembered to.
 */
const live = new Set<StagedBranch>();

onReset(() => {
  for (const staged of [...live]) {
    staged.settled = true;
    live.delete(staged);
  }
  faults.clear();
});

/**
 * Commits armed to write and then throw, by operation. The fixture for an
 * unknown outcome: the runtime cannot tell a commit that failed before its
 * write from one that failed after, so it records the outcome as
 * unreconciled and a person settles it.
 */
const faults = new Map<string, string>();

const DEFAULT_FAULT =
  "The connection dropped after the write was sent; the commit's outcome is unknown.";

/** Test and demo fixture: the next commit of `operation` writes, then throws. */
export function armCommitFault(operation: string, detail: string = DEFAULT_FAULT): void {
  faults.set(operation, detail);
}

/** The fixture stood down: a refused call never reaches its commit, so an armed fault would wait for the next one. */
export function disarmCommitFault(operation: string): void {
  faults.delete(operation);
}

/** The write has landed; a fault armed for this operation now fires, once. */
function landed(capability: string, state: DemoState): void {
  land(state);
  const fault = faults.get(capability);
  if (fault !== undefined) {
    faults.delete(capability);
    throw new Error(fault);
  }
}

/** What the open branches propose for one entity. */
export function stagedChangesFor(collection: string, key: string): Change[] {
  const entity = `${collection}:${key}`;
  const changes: Change[] = [];
  for (const staged of live) {
    for (const entry of deriveEntries(staged.branch.base, staged.branch.head)) {
      if (entry.entity === entity) {
        changes.push(entry.change);
      }
    }
  }
  return changes;
}

/** Conflicts a commit would hit right now, for a card to show before approval. */
export function projectedConflicts(capability: string): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  for (const staged of live) {
    if (staged.capability === capability) {
      conflicts.push(
        ...mergeBranch(staged.branch, getCommittedState()).conflicts,
      );
    }
  }
  return conflicts;
}

export function openProposalCount(): number {
  return live.size;
}

/**
 * Rebuilds a fork from the identity a persisted record kept, against the
 * document as it is now. Not added to the live set: it exists to be
 * reconciled, not approved. Undefined when the identity is not one this
 * adapter wrote or the handler refuses the input today.
 */
export function rebuildBranch(identity: unknown): StagedBranch | undefined {
  if (typeof identity !== "object" || identity === null) {
    return undefined;
  }
  const { capability, input, at } = identity as Partial<BranchIdentity>;
  if (typeof capability !== "string" || typeof input !== "object" || input === null || typeof at !== "number") {
    return undefined;
  }
  const owned = registry.get(capability);
  if (owned === undefined) {
    return undefined;
  }
  try {
    const { result, branch } = stage(capability, () => owned.run(input), at);
    return { capability, mode: owned.mode, branch, input, operation: owned, result, settled: false };
  } catch {
    return undefined;
  }
}

function stale(capability: string, detail: string): never {
  throw new CapabilityUnavailableError(
    unavailable(
      "APPROVAL_STALE",
      `${detail} Request the action again to review the change against current state.`,
      capability,
    ),
  );
}

function release(staged: StagedBranch): void {
  staged.settled = true;
  live.delete(staged);
}

/**
 * The operations this application is willing to stage.
 *
 * The adapter owns the code, not the capability declaration. A capability
 * names an entry here and the runtime hands it input, so nothing a
 * capability declares can reach live state outside the fork this opens.
 */
type Operation = {
  run: (input: Record<string, unknown>) => unknown;
  mode: CommitMode;
};

const registry = new Map<string, Operation>();

/** Called by the capability factory when the capability is defined. */
export function registerOperation(
  name: string,
  run: (input: Record<string, unknown>) => unknown,
  mode: CommitMode,
): void {
  registry.set(name, { run, mode });
}


/**
 * The one place this application forks, describes, and lands its own state.
 *
 * A capability author writes only a handler. It never sees the diff and never
 * decides what commit does, so the evidence a human approves is derived here
 * from the same branch that lands.
 */
export const stagingAdapter: StagingAdapter<StagedBranch> = {
  // A live view, because capabilities register as their modules load and
  // the runtime reads this at start.
  get operations() {
    return new Set(registry.keys());
  },

  scope: stagingScope,

  fork(operation, input, previous) {
    const owned = registry.get(operation);
    if (!owned) {
      throw new Error(`no staged operation named ${operation}`);
    }
    const { result, branch } = stage(
      operation,
      () => owned.run(input),
      previous?.branch.at,
    );
    const staged: StagedBranch = {
      capability: operation,
      mode: owned.mode,
      branch,
      input,
      operation: owned,
      result,
      settled: false,
    };
    live.add(staged);
    return { staged, result };
  },

  diff: (staged) => deriveChanges(staged.branch.base, staged.branch.head),

  commit(staged, restage) {
    const approved = deriveChanges(staged.branch.base, staged.branch.head);
    release(staged);

    if (staged.mode === "rederive") {
      // This adapter's fork is synchronous, so its restage is too.
      const fresh = restage() as Forked<StagedBranch>;
      const rederived = deriveChanges(
        fresh.staged.branch.base,
        fresh.staged.branch.head,
      );
      release(fresh.staged);
      if (JSON.stringify(rederived) !== JSON.stringify(approved)) {
        stale(
          staged.capability,
          "Re-running this action against current state produces a different change than the one that was approved.",
        );
      }
      landed(staged.capability, mergeBranch(fresh.staged.branch, getCommittedState()).state);
      return fresh.result;
    }

    const { state, conflicts } = mergeBranch(staged.branch, getCommittedState());
    if (conflicts.length > 0) {
      stale(
        staged.capability,
        `You changed ${conflicts
          .map((c) => `${c.collection} ${c.key} ${c.field}`)
          .join(", ")} after this was proposed, so approving it would apply part of the reviewed change and drop the rest.`,
      );
    }
    landed(staged.capability, state);
    return staged.result;
  },

  release,

  /** The durable key for a fork, since the fork itself does not clone. */
  identify: (staged): BranchIdentity => ({
    capability: staged.capability,
    input: staged.input,
    at: staged.branch.at,
  }),

  /**
   * A human went and looked. Whatever they found, this branch is finished:
   * an applied commit already reached the document and a rejected one never
   * will, so the fork is dropped either way.
   */
  reconcile(staged) {
    release(staged);
  },
};
