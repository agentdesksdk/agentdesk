import {
  CapabilityUnavailableError,
  unavailable,
  type Change,
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
import type { Branch } from "../data/types.ts";

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
  /** What the handler returned, carried so the commit hands back its receipt. */
  readonly result: unknown;
  settled: boolean;
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
});

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

/** Test and demo fixture: the next commit of `operation` writes, then throws. */
export function armCommitFault(_operation: string, _detail?: string): void {}

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
      const fresh = restage();
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
      land(mergeBranch(fresh.staged.branch, getCommittedState()).state);
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
    land(state);
    return staged.result;
  },

  release,

  /**
   * A human went and looked. Whatever they found, this branch is finished:
   * an applied commit already reached the document and a rejected one never
   * will, so the fork is dropped either way.
   */
  reconcile(staged) {
    release(staged);
  },
};
