import { receipt, type Change, type StagingAdapter } from "@agentdesksdk/webmcp";
import { MISSION, land, onReset, rows, stage, stagingScope, type RescueState } from "./state.ts";

/** One staged run of one operation: the fork it wrote, and what the handler returned. */
export type RescueFork = {
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly base: RescueState;
  readonly head: RescueState;
  readonly result: unknown;
  settled: boolean;
};

type Handler = (input: Record<string, unknown>) => unknown;

const registry = new Map<string, Handler>();

/** A capability names an operation here; the adapter owns the code that runs it. */
export function registerOperation(name: string, run: Handler): void {
  registry.set(name, run);
}

/** Field-level changes between two forks, over the four lines a person reads. */
export function deriveChanges(base: RescueState, head: RescueState): Change[] {
  const before = rows(base);
  const after = rows(head);
  const changes: Change[] = [];
  for (const field of Object.keys(after)) {
    if (before[field] !== after[field]) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }
  return changes;
}

const live = new Set<RescueFork>();
let forked = 0;
let released = 0;

function release(staged: RescueFork): void {
  if (!staged.settled) {
    released += 1;
  }
  staged.settled = true;
  live.delete(staged);
}

/** Forks that exist right now, and how many were ever forked and released, for tests. */
export function forkLedger(): { open: number; forked: number; released: number } {
  return { open: live.size, forked, released };
}

/**
 * Test fixture: the next commit of `operation` refuses before it writes.
 * The plan then stops at that operation; nothing after it runs.
 */
const faults = new Map<string, string>();

export function armCommitFault(operation: string, detail = "The dock controller did not acknowledge the write."): void {
  faults.set(operation, detail);
}

onReset(() => {
  for (const staged of [...live]) {
    staged.settled = true;
    live.delete(staged);
  }
  forked = 0;
  released = 0;
  faults.clear();
});

/**
 * The one place the rescue forks, describes, and lands its own state. A
 * capability writes only a handler; the diff a person approves and the
 * receipt a commit returns are both derived here from the same fork, so
 * nothing a capability declares can describe one change and land another.
 */
export const rescueAdapter: StagingAdapter<RescueFork> = {
  get operations() {
    return new Set(registry.keys());
  },

  scope: stagingScope,

  fork(operation, input) {
    const run = registry.get(operation);
    if (run === undefined) {
      throw new Error(`no rescue operation named ${operation}`);
    }
    const { result, base, head } = stage(() => run(input));
    const staged: RescueFork = { operation, input, base, head, result, settled: false };
    live.add(staged);
    forked += 1;
    return { staged, result };
  },

  diff: (staged) => deriveChanges(staged.base, staged.head),

  commit(staged) {
    const changes = deriveChanges(staged.base, staged.head);
    release(staged);
    const fault = faults.get(staged.operation);
    if (fault !== undefined) {
      faults.delete(staged.operation);
      throw new Error(fault);
    }
    land(staged.head);
    return receipt({
      entity: `Mission ${MISSION}`,
      changes,
      result: staged.result,
    });
  },

  release,

  reconcile(staged) {
    release(staged);
  },

  identify: (staged) => ({ operation: staged.operation, input: staged.input }),
};
