import {
  CapabilityUnavailableError,
  unavailable,
  type AppContext,
  type CapabilitySpec,
  type Change,
  type ExecutionContext,
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

type Held = { branch: Branch; result: unknown; changes: Change[] };

const held = new Map<string, Held>();

onReset(() => {
  held.clear();
});

/**
 * What the open branches propose for one entity, so a route can render the
 * document as it would be without committing to it.
 */
export function stagedChangesFor(
  collection: string,
  key: string,
): Change[] {
  const entity = `${collection}:${key}`;
  const changes: Change[] = [];
  for (const entry of held.values()) {
    for (const derived of deriveEntries(entry.branch.base, entry.branch.head)) {
      if (derived.entity === entity) {
        changes.push(derived.change);
      }
    }
  }
  return changes;
}

/** Conflicts a merge would hit right now, for a card to show before approval. */
export function projectedConflicts(
  capability: string,
  input: Record<string, unknown>,
): MergeConflict[] {
  const entry = held.get(slot(capability, input));
  if (!entry) {
    return [];
  }
  return mergeBranch(entry.branch, getCommittedState()).conflicts;
}

function slot(capability: string, input: Record<string, unknown>): string {
  const ordered = Object.keys(input)
    .sort()
    .map((key) => [key, input[key]]);
  return `${capability}|${JSON.stringify(ordered)}`;
}

function dryContext(ctx: AppContext): ExecutionContext {
  return {
    route: ctx.route,
    state: ctx.state,
    signal: new AbortController().signal,
    executionId: "DRY-RUN",
  };
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
 * Turns a capability's approval diff into evidence instead of a claim.
 *
 * `previewChanges` dry-runs the real handler on a fork and reads the diff off
 * the fork, so the human approves the operation rather than the author's
 * description of it. The fork is held while the human deliberates and lands
 * on approval, which also means the handler runs exactly once.
 */
export function stageSpec(
  spec: CapabilitySpec,
  mode: CommitMode = "merge",
): CapabilitySpec {
  const dryRun = (input: Record<string, unknown>, ctx: AppContext, at?: number) =>
    stage(() => spec.execute(input, dryContext(ctx)), at);

  return {
    ...spec,
    approvalEvidence: "derived",
    previewChanges: (input, ctx) => {
      const { result, branch } = dryRun(input, ctx);
      const changes = deriveChanges(branch.base, branch.head);
      held.set(slot(spec.name, input), { branch, result, changes });
      return changes;
    },
    execute: (input, ctx) => {
      const key = slot(spec.name, input);
      const entry = held.get(key);
      held.delete(key);
      if (!entry) {
        return spec.execute(input, ctx);
      }
      if (mode === "rederive") {
        const fresh = dryRun(input, ctx, entry.branch.at);
        const changes = deriveChanges(fresh.branch.base, fresh.branch.head);
        if (JSON.stringify(changes) !== JSON.stringify(entry.changes)) {
          stale(
            spec.name,
            "Re-running this action against current state produces a different change than the one that was approved.",
          );
        }
        land(mergeBranch(fresh.branch, getCommittedState()).state);
        return fresh.result;
      }
      const { state, conflicts } = mergeBranch(entry.branch, getCommittedState());
      if (conflicts.length > 0) {
        stale(
          spec.name,
          `You changed ${conflicts.map((c) => `${c.collection} ${c.key} ${c.field}`).join(", ")} after this was proposed, so approving it would apply part of the reviewed change and drop the rest.`,
        );
      }
      land(state);
      return entry.result;
    },
  };
}
