import {
  CapabilityUnavailableError,
  unavailable,
  type Change,
  type ExecutionContext,
  type StagedProposal,
  type StageHandler,
} from "@agentdesk/webmcp";
import {
  deriveChanges,
  deriveEntries,
  mergeBranch,
  type MergeConflict,
} from "../data/branch.ts";
import { getCommittedState, land, onReset, stage } from "../data/store.ts";
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

/** A handler that stages. Synchronous by contract, checked at definition. */
export type StagedExecute = (
  input: Record<string, unknown>,
  ctx: ExecutionContext,
) => unknown;

/**
 * Proposals that exist right now.
 *
 * A proposal joins on creation and leaves on commit or discard, and the
 * runtime owns both ends, so this set is exactly the set of changes a human
 * could still approve. Rejecting an action removes its ghost because the
 * runtime discarded the artifact, not because the UI remembered to.
 */
const live = new Set<DemoProposal>();

onReset(() => {
  for (const proposal of [...live]) {
    proposal.discard();
  }
});

type DemoProposal = StagedProposal & {
  readonly capability: string;
  readonly branch: Branch;
};

/** What the open proposals would change for one entity. */
export function stagedChangesFor(collection: string, key: string): Change[] {
  const entity = `${collection}:${key}`;
  const changes: Change[] = [];
  for (const proposal of live) {
    for (const entry of deriveEntries(
      proposal.branch.base,
      proposal.branch.head,
    )) {
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
  for (const proposal of live) {
    if (proposal.capability === capability) {
      conflicts.push(
        ...mergeBranch(proposal.branch, getCommittedState()).conflicts,
      );
    }
  }
  return conflicts;
}

export function openProposalCount(): number {
  return live.size;
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

/**
 * Turns a write handler into a staged one.
 *
 * The handler runs against a fork, the diff is read off that fork, and the
 * same fork is what lands. The human approves the operation rather than a
 * description of it, and the two cannot drift because there is only one.
 */
export function stagedHandler(
  name: string,
  execute: StagedExecute,
  mode: CommitMode = "merge",
): StageHandler {
  const run = (
    input: Record<string, unknown>,
    ctx: ExecutionContext,
    at?: number,
  ) => stage(name, () => execute(input, ctx), at);

  return (input, ctx) => {
    const { result, branch } = run(input, ctx);
    const changes = deriveChanges(branch.base, branch.head);
    let settled = false;

    const proposal: DemoProposal = {
      capability: name,
      branch,
      changes,
      commit: () => {
        if (settled) {
          throw new Error(`${name} staged a change that was already settled`);
        }
        settled = true;
        live.delete(proposal);

        if (mode === "rederive") {
          const fresh = run(input, ctx, branch.at);
          const rederived = deriveChanges(
            fresh.branch.base,
            fresh.branch.head,
          );
          if (JSON.stringify(rederived) !== JSON.stringify(changes)) {
            stale(
              name,
              "Re-running this action against current state produces a different change than the one that was approved.",
            );
          }
          land(mergeBranch(fresh.branch, getCommittedState()).state);
          return fresh.result;
        }

        const { state, conflicts } = mergeBranch(branch, getCommittedState());
        if (conflicts.length > 0) {
          stale(
            name,
            `You changed ${conflicts
              .map((c) => `${c.collection} ${c.key} ${c.field}`)
              .join(", ")} after this was proposed, so approving it would apply part of the reviewed change and drop the rest.`,
          );
        }
        land(state);
        return result;
      },
      discard: () => {
        settled = true;
        live.delete(proposal);
      },
    };

    live.add(proposal);
    return proposal;
  };
}
