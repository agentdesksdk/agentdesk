import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  StagedProposalStore,
  type Capability,
  type StagedProposal,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

/**
 * A store the staged handlers fork. Small enough to reason about, and it
 * makes "did this reach live state" a single readable assertion.
 */
type Doc = Record<string, string>;

function makeStore() {
  let live: Doc = { status: "processing" };
  let open: Doc | null = null;

  type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };
  const artifacts: Artifact[] = [];

  const registry = new Map<string, (draft: Doc) => void>();

  const adapter: StagingAdapter<Artifact> = {
    get operations() {
      return new Set(registry.keys());
    },
    scope: (run) => {
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
    },
    fork(operation) {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      const before = { ...open };
      const result = registry.get(operation)!(open);
      const artifact: Artifact = {
        name: operation,
        before,
        head: { ...open },
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
    register: (operation: string, write: (draft: Doc) => void) => {
      registry.set(operation, write);
    },
    artifacts,
    last: () => artifacts[artifacts.length - 1]!,
    handed: artifacts,
    draft: (): Doc => {
      if (open === null) {
        throw new Error("no fork is open");
      }
      return open;
    },
    committed: () => ({ ...live }),
  };
}

type Store = ReturnType<typeof makeStore>;

function stagedCapability(
  store: Store,
  name: string,
  write: (draft: Record<string, string>) => void,
): Capability {
  store.register(name, write);
  return defineCapability({
    name,
    description: `Stages ${name} for approval.`,
    risk: "CONSEQUENTIAL",
    staging: { operation: name },
  });
}

function startRuntime(capabilities: Capability[], store?: Store) {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    ...(store ? { staging: store.adapter } : {}),
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
        staging: { write: () => undefined },
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
        staging: { write: () => undefined },
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
      staging: store.adapter,
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
