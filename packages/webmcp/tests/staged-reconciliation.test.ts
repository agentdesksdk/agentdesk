import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type Capability,
  type StagedResolution,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

type Doc = Record<string, unknown>;
type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };

/**
 * An adapter that records what the runtime asked it to do with each artifact,
 * so "did this become terminal" is an assertion rather than an inference.
 */
function makeAdapter(
  operations: Record<string, (draft: Doc) => void>,
  overrides: Partial<StagingAdapter<Artifact>> = {},
) {
  let live: Doc = { status: "safe" };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  const resolutions: StagedResolution[] = [];

  const base: StagingAdapter<Artifact> = {
    operations: new Set(Object.keys(operations)),
    scope: (run) => {
      const outermost = open === null;
      if (open === null) {
        open = structuredClone(live);
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
        open = structuredClone(live);
      }
      const before = structuredClone(open);
      const result = operations[operation]!(open);
      const artifact: Artifact = {
        name: operation,
        before,
        head: structuredClone(open),
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
        .filter(
          (key) =>
            JSON.stringify(artifact.before[key]) !==
            JSON.stringify(artifact.head[key]),
        )
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
        changes: [],
        undoable: false,
        result: structuredClone(artifact.head),
      });
    },
    release: (artifact) => {
      artifact.settled = true;
    },
    reconcile: (artifact, resolution) => {
      resolutions.push(resolution);
      artifact.settled = true;
    },
  };

  return {
    adapter: { ...base, ...overrides },
    liveState: () => structuredClone(live),
    setLive: (next: Doc) => {
      live = next;
    },
    openArtifacts: () => artifacts.filter((artifact) => !artifact.settled),
    resolutions: () => [...resolutions],
  };
}

const staged = (name: string, operation: string): Capability =>
  defineCapability({
    name,
    description: `Stages ${operation}.`,
    risk: "CONSEQUENTIAL",
    staging: { operation },
  });

function startRuntime(
  adapter: StagingAdapter<Artifact>,
  capabilities: Capability[],
) {
  return createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    staging: adapter,
  });
}

/** An adapter whose commit writes and then loses its acknowledgement. */
function landsThenThrows() {
  const store = makeAdapter(
    {
      cancel: (draft) => {
        draft.status = "cancelled";
      },
      note: (draft) => {
        draft.note = "written";
      },
    },
    {
      commit: (artifact: Artifact) => {
        store.setLive({ ...store.liveState(), ...artifact.head });
        throw new Error("ack lost");
      },
    },
  );
  return store;
}

describe("a plan whose commit outcome is unknown", () => {
  it("says INDETERMINATE rather than FAILED, on the plan and the operation", async () => {
    const store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    const committed = await runtime.commitPlan(plan.id);

    expect(store.liveState().status).toBe("cancelled");
    expect(committed.plan?.status).toBe("INDETERMINATE");
    expect(committed.plan?.outcomes?.[0]?.status).toBe("INDETERMINATE");
    if (committed.ok) {
      throw new Error("expected the commit to be reported as unresolved");
    }
    expect(committed.reason).toMatch(/not retry|unknown/i);
  });

  it("links the record to the plan and the operation it belongs to", async () => {
    const store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [{ capability: "cancel_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);
    await runtime.commitPlan(plan.id);

    const [open] = runtime.listUnreconciled();
    expect(open?.planId).toBe(plan.id);
    expect(open?.operationIndex).toBe(0);
    expect(committedRecordId(runtime, plan.id)).toBe(open?.id);
  });

  it("stops the plan rather than building on an unknown result", async () => {
    const store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
      staged("note_thing", "note"),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [
        { capability: "cancel_thing", input: {} },
        { capability: "note_thing", input: {} },
      ],
    });
    runtime.approvePlan(plan.id, HUMAN);

    const committed = await runtime.commitPlan(plan.id);

    // The second operation would be writing on top of a change nobody can
    // confirm, so it is skipped rather than attempted.
    expect(committed.plan?.outcomes?.[0]?.status).toBe("INDETERMINATE");
    expect(committed.plan?.outcomes?.[1]?.status).toBe("SKIPPED");
    expect(store.liveState().note).toBeUndefined();
  });
});

function committedRecordId(
  runtime: ReturnType<typeof startRuntime>,
  planId: string,
): string | undefined {
  return runtime
    .getPlan(planId)
    ?.outcomes?.find((outcome) => outcome.status === "INDETERMINATE")?.recordId;
}

describe("reconciliation reaches the adapter", () => {
  it("asks the adapter to settle an indeterminate commit", async () => {
    const store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, HUMAN);
    expect(store.openArtifacts()).toHaveLength(1);

    const settled = runtime.reconcile(actionId, { kind: "commit_applied" }, HUMAN);

    expect(settled.ok).toBe(true);
    expect(store.resolutions()).toEqual([{ kind: "commit_applied" }]);
    expect(store.openArtifacts()).toEqual([]);
    expect(runtime.listUnreconciled()).toEqual([]);
  });

  it("keeps the record and the evidence when recovery throws", async () => {
    const store = landsThenThrows();
    store.adapter.reconcile = () => {
      throw new Error("still cannot reach it");
    };
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, HUMAN);

    const attempted = runtime.reconcile(
      actionId,
      { kind: "commit_applied" },
      HUMAN,
    );

    expect(attempted.ok).toBe(false);
    const [open] = runtime.listUnreconciled();
    expect(open?.changes).toEqual([
      { field: "status", before: "safe", after: "cancelled" },
    ]);
    expect(store.openArtifacts()).toHaveLength(1);
  });

  it("settles a failed disposal through its own resolution", async () => {
    const store = makeAdapter(
      {
        cancel: (draft) => {
          draft.status = "cancelled";
        },
      },
      {
        diff: () => {
          throw new Error("cannot describe this");
        },
        release: () => {
          throw new Error("cleanup exploded");
        },
      },
    );
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const [open] = runtime.listUnreconciled();
    expect(open?.kind).toBe("cleanup_failed");

    const settled = runtime.reconcile(open!.id, { kind: "cleanup_disposed" }, HUMAN);

    expect(settled.ok).toBe(true);
    expect(store.resolutions()).toEqual([{ kind: "cleanup_disposed" }]);
    expect(runtime.listUnreconciled()).toEqual([]);
  });
});

describe("reset does not forget unresolved work", () => {
  it("keeps an indeterminate commit that predates it", async () => {
    const store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    await runtime.reset();

    expect(runtime.listUnreconciled()).toHaveLength(1);
    expect(store.openArtifacts()).toHaveLength(1);
  });

  it("keeps a cleanup failure raised by the reset itself", async () => {
    const store = makeAdapter(
      {
        cancel: (draft) => {
          draft.status = "cancelled";
        },
      },
      {
        release: () => {
          throw new Error("cleanup exploded during reset");
        },
      },
    );
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    expect(runtime.listUnreconciled()).toEqual([]);

    await runtime.reset();

    const open = runtime.listUnreconciled();
    expect(open).toHaveLength(1);
    expect(open[0]?.detail).toContain("cleanup exploded during reset");
    expect(store.openArtifacts()).toHaveLength(1);
  });
});

describe("reconciliation evidence cannot be rewritten", () => {
  it("ignores mutation of the array, the change, and its nested values", async () => {
    const store = makeAdapter(
      {
        cancel: (draft) => {
          draft.status = { state: "cancelled", by: "agent" };
        },
      },
      {
        commit: (artifact: Artifact) => {
          store.setLive({ ...store.liveState(), ...artifact.head });
          throw new Error("ack lost");
        },
      },
    );
    const runtime = startRuntime(store.adapter, [
      staged("cancel_thing", "cancel"),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, HUMAN);

    const first = runtime.listUnreconciled();
    // Cast through unknown, because a JavaScript caller has no types to stop
    // it. The evidence has to defend itself.
    const changes = first[0]!.changes as unknown as Array<{
      after: { state: string };
    }>;
    try {
      (changes as unknown[]).push({ field: "extra" });
      changes[0]!.after = { state: "forged" };
      changes[0]!.after.state = "forged";
    } catch {
      // Frozen evidence throws in strict mode, which is also a pass.
    }

    const second = runtime.listUnreconciled();
    expect(second[0]?.changes).toHaveLength(1);
    expect(second[0]?.changes[0]?.after).toEqual({
      state: "cancelled",
      by: "agent",
    });

    const status = await runtime.invoke("get_action_status", {
      approval_id: actionId,
    });
    expect(status.content[0]!.text!).toContain("cancelled");
    expect(status.content[0]!.text!).not.toContain("forged");
  });
});
