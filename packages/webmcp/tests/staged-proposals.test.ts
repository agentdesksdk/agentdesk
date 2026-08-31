import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  StagedProposalStore,
  type Capability,
  type Change,
  type StagedProposal,
  type StagingScope,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

/**
 * A store the staged handlers fork. Small enough to reason about, and it
 * makes "did this reach live state" a single readable assertion.
 */
function makeStore() {
  let live: Record<string, string> = { status: "processing" };
  let open: Record<string, string> | null = null;
  const handed: Array<StagedProposal & { settled: boolean }> = [];

  return {
    handed,
    /** The proposal most recently handed to the runtime. */
    last: () => handed[handed.length - 1]!,
    read: () => ({ ...live }),
    committed: () => ({ ...live }),
    scope: (<T,>(run: () => T): T => {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      try {
        return run();
      } finally {
        if (outermost) {
          open = null;
        }
      }
    }) as StagingScope,
    /** Stages `write` on a fork and hands back the proposal that lands it. */
    propose(name: string, write: (draft: Record<string, string>) => void) {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      const before = { ...open };
      write(open);
      const head = { ...open };
      if (outermost) {
        open = null;
      }
      const changes: Change[] = Object.keys(head)
        .filter((key) => before[key] !== head[key])
        .map((key) => ({
          field: key,
          before: before[key] ?? null,
          after: head[key],
        }));
      let settled = false;
      const proposal: StagedProposal = {
        changes,
        commit: () => {
          settled = true;
          live = { ...live, ...head };
          return receipt({
            entity: name,
            changes,
            undoable: false,
            result: { ...head },
          });
        },
        discard: () => {
          settled = true;
        },
      };
      Object.defineProperty(proposal, "settled", { get: () => settled });
      handed.push(proposal as StagedProposal & { settled: boolean });
      return proposal;
    },
  };
}

type Store = ReturnType<typeof makeStore>;

function stagedCapability(
  store: Store,
  name: string,
  write: (draft: Record<string, string>) => void,
): Capability {
  return defineCapability({
    name,
    description: `Stages ${name} for approval.`,
    risk: "CONSEQUENTIAL",
    stage: () => store.propose(name, write),
  });
}

function startRuntime(capabilities: Capability[], store?: Store) {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    ...(store ? { stagingScope: store.scope } : {}),
  });
  return runtime;
}

describe("derived evidence cannot be self-attested", () => {
  it("refuses a capability that pairs the label with an ordinary preview", () => {
    expect(() =>
      defineCapability({
        name: "claims_derived",
        description: "Claims derived evidence with a hand-written preview.",
        risk: "CONSEQUENTIAL",
        previewChanges: () => [
          { field: "status", before: "processing", after: "cancelled" },
        ],
        // The public spec has no "derived" member, so this is the only way a
        // JavaScript caller could reach it.
        approvalEvidence: "derived" as unknown as "diff",
        execute: () => ({ ok: true }),
      } as never),
    ).toThrow();
  });

  it("refuses a staged capability that also declares a preview", () => {
    const store = makeStore();
    expect(() =>
      defineCapability({
        name: "stage_and_preview",
        description: "Declares both a staged run and a hand-written preview.",
        risk: "CONSEQUENTIAL",
        stage: () => store.propose("stage_and_preview", (d) => {
          d.status = "cancelled";
        }),
        previewChanges: () => [],
      } as never),
    ).toThrow(/previewChanges or approvalEvidence/);
  });

  it("refuses a staged capability that also declares a handler", () => {
    const store = makeStore();
    expect(() =>
      defineCapability({
        name: "stage_and_execute",
        description: "Declares both a staged run and a direct handler.",
        risk: "CONSEQUENTIAL",
        stage: () => store.propose("stage_and_execute", (d) => {
          d.status = "cancelled";
        }),
        execute: () => ({ ok: true }),
      } as never),
    ).toThrow(/both stage and execute/);
  });

  it("labels a staged capability derived and leaves it with no runnable handler", () => {
    const store = makeStore();
    const capability = stagedCapability(store, "cancel_thing", (draft) => {
      draft.status = "cancelled";
    });
    expect(capability.approvalEvidence).toBe("derived");
    expect(() =>
      capability.execute({}, {
        route: "/",
        state: {},
        signal: new AbortController().signal,
        executionId: "EXE-0",
      }),
    ).toThrow(/must be committed through the proposal/);
  });
});

describe("a staged handler must be synchronous", () => {
  it("refuses an async stage handler at definition", () => {
    const store = makeStore();
    expect(() =>
      defineCapability({
        name: "async_stage",
        description: "Stages asynchronously.",
        risk: "CONSEQUENTIAL",
        stage: async () =>
          store.propose("async_stage", (d) => {
            d.status = "cancelled";
          }),
      } as never),
    ).toThrow(/async stage handler/);
  });

  it("refuses a plain handler that hands back a promise", async () => {
    const capability = defineCapability({
      name: "thenable_stage",
      description: "Returns a promise from a non-async function.",
      risk: "CONSEQUENTIAL",
      stage: () => Promise.resolve({ changes: [], commit: () => ({}), discard: () => {} }) as never,
    });
    const runtime = startRuntime([capability]);
    await runtime.start();
    const result = await runtime.invoke("thenable_stage", {});
    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });
});

describe("a proposal belongs to its approval", () => {
  let store: Store;
  let runtime: ReturnType<typeof startRuntime>;

  beforeEach(async () => {
    store = makeStore();
    runtime = startRuntime(
      [
        stagedCapability(store, "cancel_thing", (draft) => {
          draft.status = "cancelled";
        }),
      ],
      store,
    );
    await runtime.start();
  });

  it("stages without touching live state", async () => {
    const result = await runtime.invoke("cancel_thing", {});
    expect(result.data?.approvalEvidence).toBe("derived");
    expect(result.data?.will_change).toEqual([
      { field: "status", before: "processing", after: "cancelled" },
    ]);
    expect(store.committed()).toEqual({ status: "processing" });
  });

  it("discards the proposal when the human rejects", async () => {
    await runtime.invoke("cancel_thing", {});
    const [pending] = runtime.getSnapshot().pending;
    const proposal = store.last();
    runtime.reject(pending!.id, HUMAN);

    expect(proposal.settled).toBe(true);
    expect(store.committed()).toEqual({ status: "processing" });
  });

  it("discards the proposal when policy starts denying", async () => {
    let deny = false;
    const denying = createAgentDeskRuntime({
      capabilities: [
        stagedCapability(store, "cancel_thing", (draft) => {
          draft.status = "cancelled";
        }),
      ],
      registerTool: async () => {},
      actor: { id: "agent", name: "Agent", kind: "agent" },
      stagingScope: store.scope,
      policy: () =>
        deny ? { kind: "deny", reason: "blocked" } : { kind: "require_approval" },
    });
    await denying.start();
    await denying.invoke("cancel_thing", {});
    const proposal = store.last();
    deny = true;

    const result = await denying.approve(
      denying.getSnapshot().pending[0]!.id,
      HUMAN,
    );

    expect(result.code).toBe("POLICY_DENIED");
    expect(proposal.settled).toBe(true);
    expect(store.committed()).toEqual({ status: "processing" });
  });

  it("discards every proposal on reset", async () => {
    await runtime.invoke("cancel_thing", {});
    const proposal = store.last();
    await runtime.reset();

    expect(proposal.settled).toBe(true);
  });

  it("discards every proposal on stop", async () => {
    await runtime.invoke("cancel_thing", {});
    const proposal = store.last();
    await runtime.stop();

    expect(proposal.settled).toBe(true);
  });

  it("keeps the artifact behind an already-pending request rather than replacing it", async () => {
    const first = await runtime.invoke("cancel_thing", {});
    const original = store.last();
    const repeat = await runtime.invoke("cancel_thing", {});

    // The same pending action is returned, so its shown preview still comes
    // from the artifact the runtime holds.
    expect(repeat.data?.approval_id).toBe(first.data?.approval_id);
    expect(runtime.getSnapshot().pending).toHaveLength(1);
    expect(original.settled).toBe(false);
    expect(store.last().settled).toBe(true);

    const approved = await runtime.approve(
      runtime.getSnapshot().pending[0]!.id,
      HUMAN,
    );
    expect(approved.code).toBeUndefined();
    expect(store.committed()).toEqual({ status: "cancelled" });
  });

  it("keeps two plans and a direct approval on separate artifacts", async () => {
    const first = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    const second = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    await runtime.invoke("cancel_thing", {});
    const direct = runtime.getSnapshot().pending[0]!.id;

    // Three owners, three artifacts, none of them consuming another's.
    expect(store.handed).toHaveLength(3);
    expect(store.handed.every((proposal) => !proposal.settled)).toBe(true);

    runtime.approvePlan(first.id, HUMAN);
    const committed = await runtime.commitPlan(first.id);
    expect(committed.ok).toBe(true);

    // Rejecting the second plan disposes only its own artifact.
    runtime.rejectPlan(second.id);
    const approved = await runtime.approve(direct, HUMAN);
    expect(approved.data?.reasonCode).not.toBe("STAGED_PROPOSAL_MISSING");
  });

  it("fails the whole plan rather than committing part of it without artifacts", async () => {
    const plan = await runtime.prepare({
      operations: [
        { capability: "cancel_thing", input: {} },
        { capability: "cancel_thing", input: { note: "second" } },
      ],
    });
    runtime.approvePlan(plan.id, HUMAN);
    // stop() disposes staged artifacts and leaves plans addressable, so an
    // approved plan can outlive the changes it was reviewed against.
    await runtime.stop();

    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(false);
    if (committed.ok) {
      throw new Error("expected the commit to be refused");
    }
    expect(committed.reason).toMatch(/no longer held by the runtime/);
    expect(committed.plan?.status).toBe("FAILED");
    // Nothing landed, including the operation whose turn came first.
    expect(store.committed()).toEqual({ status: "processing" });
  });
});

describe("the proposal store keys on runtime identity", () => {
  it("never lets one key hold two live proposals", () => {
    const store = new StagedProposalStore();
    let firstDiscarded = false;
    const first: StagedProposal = {
      changes: [],
      commit: () => ({}),
      discard: () => {
        firstDiscarded = true;
      },
    };
    const second: StagedProposal = {
      changes: [],
      commit: () => ({}),
      discard: () => {},
    };

    store.put("APR-1", first);
    store.put("APR-1", second);

    expect(firstDiscarded).toBe(true);
    expect(store.size()).toBe(1);
    expect(store.take("APR-1")).toBe(second);
    expect(store.size()).toBe(0);
  });

  it("scopes plan disposal to one plan", () => {
    const store = new StagedProposalStore();
    const discarded: string[] = [];
    const proposal = (label: string): StagedProposal => ({
      changes: [],
      commit: () => ({}),
      discard: () => discarded.push(label),
    });

    store.put(StagedProposalStore.planKey("PLAN-1", 0), proposal("a"));
    store.put(StagedProposalStore.planKey("PLAN-1", 1), proposal("b"));
    store.put(StagedProposalStore.planKey("PLAN-2", 0), proposal("c"));
    store.discardPlan("PLAN-1");

    expect(discarded).toEqual(["a", "b"]);
    expect(store.size()).toBe(1);
  });
});
