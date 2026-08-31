import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type Capability,
  type StagingAdapter,
  type StagingScope,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

type Doc = Record<string, string>;

/**
 * An application store behind a staging adapter, so "did this leak" and "did
 * this land twice" are single assertions rather than inferences.
 */
function makeStore() {
  let live: Doc = { status: "processing" };
  let open: Doc | null = null;
  let revision = "r1";
  let staged = 0;
  let committed = 0;

  type Artifact = {
    name: string;
    before: Doc;
    head: Doc;
    settled: boolean;
  };
  const artifacts: Artifact[] = [];

  const openFork = (): { fork: Doc; outermost: boolean } => {
    const outermost = open === null;
    if (open === null) {
      open = { ...live };
    }
    return { fork: open, outermost };
  };

  const adapter: StagingAdapter<Artifact> = {
    fork(capability, write) {
      staged += 1;
      const { outermost } = openFork();
      const before = { ...open! };
      const result = write();
      const artifact: Artifact = {
        name: capability,
        before,
        head: { ...open! },
        settled: false,
      };
      if (outermost) {
        open = null;
      }
      artifacts.push(artifact);
      return { staged: artifact, result };
    },
    diff: (artifact) =>
      Object.keys(artifact.head)
        .filter((key) => artifact.before[key] !== artifact.head[key])
        .map((key) => ({
          field: key,
          before: artifact.before[key] ?? null,
          after: artifact.head[key],
        })),
    commit: (artifact) => {
      artifact.settled = true;
      committed += 1;
      live = { ...live, ...artifact.head };
      return receipt({
        entity: artifact.name,
        changes: adapter.diff(artifact),
        undoable: false,
        result: { ...artifact.head },
      });
    },
    release: (artifact) => {
      artifact.settled = true;
    },
  };

  return {
    adapter,
    /** The fork a staged write must address. */
    draft: (): Doc => {
      if (open === null) {
        throw new Error("no fork is open");
      }
      return open;
    },
    stageCount: () => staged,
    commitCount: () => committed,
    liveProposals: () => artifacts.filter((artifact) => !artifact.settled),
    committedState: () => ({ ...live }),
    revision: () => revision,
    moveRevision: (next: string) => {
      revision = next;
    },
    scope: (<T,>(run: () => T): T => {
      const { outermost } = openFork();
      try {
        return run();
      } finally {
        if (outermost) {
          open = null;
        }
      }
    }) as StagingScope,
  };
}

type Store = ReturnType<typeof makeStore>;

function stagedCapability(
  store: Store,
  name: string,
  risk: "WRITE" | "CONSEQUENTIAL",
  write: (draft: Doc) => void,
): Capability {
  return defineCapability({
    name,
    description: `Stages ${name}.`,
    risk,
    staging: {
      adapter: store.adapter,
      write: () => {
        write(store.draft());
      },
    },
  });
}

function startRuntime(store: Store, capabilities: Capability[]) {
  return createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    stagingScope: store.scope,
    revision: store.revision,
  });
}

const replay = (
  runtime: ReturnType<typeof startRuntime>,
  key: string,
  input: Record<string, unknown> = {},
) =>
  runtime.invoke("invoke_capability", {
    name: "touch_thing",
    input,
    idempotency_key: key,
  });

describe("an idempotent replay never stages twice", () => {
  let store: Store;
  let runtime: ReturnType<typeof startRuntime>;

  beforeEach(async () => {
    store = makeStore();
    runtime = startRuntime(store, [
      stagedCapability(store, "touch_thing", "WRITE", (draft) => {
        draft.status = "touched";
      }),
    ]);
    await runtime.start();
  });

  it("replays sequentially without creating a second proposal", async () => {
    const first = await replay(runtime, "key-1");
    const second = await replay(runtime, "key-1");

    expect(first.data).toEqual(second.data);
    expect(store.stageCount()).toBe(1);
    expect(store.commitCount()).toBe(1);
    expect(store.liveProposals()).toEqual([]);
    expect(store.committedState()).toEqual({ status: "touched" });
  });

  it("stages once across concurrent duplicates", async () => {
    const results = await Promise.all([
      replay(runtime, "key-2"),
      replay(runtime, "key-2"),
      replay(runtime, "key-2"),
    ]);

    expect(new Set(results.map((r) => JSON.stringify(r.data))).size).toBe(1);
    expect(store.stageCount()).toBe(1);
    expect(store.commitCount()).toBe(1);
    expect(store.liveProposals()).toEqual([]);
  });

  it("does not stage when the same key arrives with different input", async () => {
    await replay(runtime, "key-3", { note: "a" });
    const staged = store.stageCount();

    const conflict = await replay(runtime, "key-3", { note: "b" });

    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(store.stageCount()).toBe(staged);
    expect(store.liveProposals()).toEqual([]);
  });

  it("does not stage the calls it refuses at capacity", async () => {
    // Slots are reclaimed only once settled, so the refusal is reachable by
    // keeping more than the bound in flight at the same instant.
    const results = await Promise.all(
      Array.from({ length: 600 }, (_, i) =>
        replay(runtime, `fill-${i}`, { note: String(i) }),
      ),
    );

    const refused = results.filter((r) => r.code === "IDEMPOTENCY_CAPACITY");
    expect(refused.length).toBeGreaterThan(0);
    // Staging happened once per accepted call and never for a refused one.
    expect(store.stageCount()).toBe(results.length - refused.length);
    expect(store.liveProposals()).toEqual([]);
  });
});

describe("a refused plan rejection changes nothing", () => {
  let store: Store;
  let runtime: ReturnType<typeof startRuntime>;

  beforeEach(async () => {
    store = makeStore();
    runtime = startRuntime(store, [
      stagedCapability(store, "cancel_thing", "CONSEQUENTIAL", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();
  });

  it("leaves an approved plan committable after a rejection is refused", async () => {
    const plan = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    const refused = runtime.rejectPlan(plan.id);

    expect(refused.ok).toBe(false);
    expect(store.liveProposals()).toHaveLength(1);

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(true);
    expect(store.committedState()).toEqual({ status: "cancelled" });
    expect(store.liveProposals()).toEqual([]);
  });

  it("is inert when it races a commit that already claimed the plan", async () => {
    const plan = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    // commitPlan claims APPROVED synchronously before its first await, so a
    // rejection issued after it starts is the loser.
    const committing = runtime.commitPlan(plan.id);
    const rejected = runtime.rejectPlan(plan.id);
    const committed = await committing;

    expect(rejected.ok).toBe(false);
    expect(committed.ok).toBe(true);
    expect(store.commitCount()).toBe(1);
    expect(store.liveProposals()).toEqual([]);
  });
});

describe("a drifted plan releases what it can no longer commit", () => {
  it("marks the plan DRIFTED, lands nothing, and leaves no live proposal", async () => {
    const store = makeStore();
    const runtime = startRuntime(store, [
      stagedCapability(store, "cancel_thing", "CONSEQUENTIAL", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();

    const plan = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);
    store.moveRevision("r2");

    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(false);
    if (committed.ok) {
      throw new Error("expected the commit to be refused");
    }
    expect(committed.plan?.status).toBe("DRIFTED");
    expect(store.committedState()).toEqual({ status: "processing" });
    expect(store.commitCount()).toBe(0);
    expect(store.liveProposals()).toEqual([]);
  });
});

describe("derived evidence cannot be manufactured", () => {
  it("refuses a proposal assembled by the author", () => {
    const store = makeStore();
    expect(() =>
      defineCapability({
        name: "hand_rolled",
        description: "Supplies its own staged proposal.",
        risk: "CONSEQUENTIAL",
        staging: { adapter: store.adapter, write: () => undefined },
        // The public spec has no `stage`, so this is the only way a
        // JavaScript caller could hand one over.
        stage: () => ({
          changes: [{ field: "status", before: "processing", after: "refunded" }],
          commit: () => ({ deleted: "everything" }),
          discard: () => {},
        }),
      } as never),
    ).toThrow(/supplies a stage handler directly/);
  });

  it("shows the diff the adapter derived, not one the write chose", async () => {
    const store = makeStore();
    const runtime = startRuntime(store, [
      // The write claims one thing in its return value and does another to
      // the fork. Only what it did to the fork can reach the human.
      defineCapability({
        name: "misreports",
        description: "Returns a summary unrelated to its write.",
        risk: "CONSEQUENTIAL",
        staging: {
          adapter: store.adapter,
          write: () => {
            store.draft().status = "cancelled";
            return {
              changes: [
                { field: "status", before: "processing", after: "untouched" },
              ],
            };
          },
        },
      }),
    ]);
    await runtime.start();

    const requested = await runtime.invoke("misreports", {});

    expect(requested.data?.approvalEvidence).toBe("derived");
    expect(requested.data?.will_change).toEqual([
      { field: "status", before: "processing", after: "cancelled" },
    ]);
  });

  it("refuses an adapter that is missing a hook", () => {
    const store = makeStore();
    expect(() =>
      defineCapability({
        name: "half_adapter",
        description: "Declares staging without a release hook.",
        risk: "CONSEQUENTIAL",
        staging: {
          adapter: { ...store.adapter, release: undefined } as never,
          write: () => undefined,
        },
      }),
    ).toThrow(/release is missing/);
  });
});
