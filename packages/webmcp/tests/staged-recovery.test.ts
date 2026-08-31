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

function makeAdapter(
  operations: Record<string, (draft: Doc) => void>,
  overrides: Partial<StagingAdapter<Artifact>> = {},
) {
  let live: Doc = { count: 0 };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  const resolutions: StagedResolution[] = [];
  let dispatches = 0;

  const base: StagingAdapter<Artifact> = {
    operations: new Set(Object.keys(operations)),
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
      const result = operations[operation]!(open);
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
      dispatches += 1;
      artifact.settled = true;
      live = { ...live, ...artifact.head };
      return receipt({
        entity: artifact.name,
        changes: [],
        undoable: false,
        result: { ...artifact.head },
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
    liveState: () => ({ ...live }),
    setLive: (next: Doc) => {
      live = next;
    },
    dispatches: () => dispatches,
    countDispatch: () => {
      dispatches += 1;
    },
    openArtifacts: () => artifacts.filter((artifact) => !artifact.settled),
    resolutions: () => [...resolutions],
  };
}

const staged = (
  name: string,
  operation: string,
  risk: "WRITE" | "CONSEQUENTIAL" = "WRITE",
): Capability =>
  defineCapability({
    name,
    description: `Stages ${operation}.`,
    risk,
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

/** Increments and then loses its acknowledgement, so the outcome is unknown. */
function incrementsThenThrows() {
  const store = makeAdapter(
    {
      bump: (draft) => {
        draft.count = (draft.count as number) + 1;
      },
    },
    {
      commit: (artifact: Artifact) => {
        store.countDispatch();
        store.setLive({ ...store.liveState(), ...artifact.head });
        throw new Error("ack lost");
      },
    },
  );
  return store;
}

describe("a direct staged write reports and guards an unknown outcome", () => {
  it("returns the record and a do-not-retry instruction", async () => {
    const store = incrementsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("bump_thing", "bump")]);
    await runtime.start();

    const result = await runtime.invoke("bump_thing", {});

    expect(result.code).toBe("EXECUTION_INDETERMINATE");
    const [open] = runtime.listUnreconciled();
    expect(result.data?.record_id).toBe(open?.id);
    expect(String(result.data?.hint)).toMatch(/not retry/i);
    expect(result.data?.changes).toEqual([
      { field: "count", before: 0, after: 1 },
    ]);
  });

  it("refuses a repeat while the earlier outcome is unresolved", async () => {
    const store = incrementsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("bump_thing", "bump")]);
    await runtime.start();
    await runtime.invoke("bump_thing", {});

    const again = await runtime.invoke("bump_thing", {});

    expect(again.code).toBe("EXECUTION_INDETERMINATE");
    // The operation was never dispatched a second time, so live state moved
    // once even though the caller asked twice.
    expect(store.dispatches()).toBe(1);
    expect(store.liveState().count).toBe(1);
    expect(runtime.listUnreconciled()).toHaveLength(1);
  });

  it("allows the operation again once a human has reconciled it", async () => {
    const store = incrementsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("bump_thing", "bump")]);
    await runtime.start();
    await runtime.invoke("bump_thing", {});
    const [open] = runtime.listUnreconciled();

    runtime.reconcile(open!.id, { kind: "commit_applied" }, HUMAN);
    const after = await runtime.invoke("bump_thing", {});

    expect(runtime.listUnreconciled()).toHaveLength(1);
    expect(after.code).toBe("EXECUTION_INDETERMINATE");
    expect(store.dispatches()).toBe(2);
  });
});

describe("evidence is made durable before anything is dispatched", () => {
  const uncloneable = (): Partial<StagingAdapter<Artifact>> => ({
    diff: () => [{ field: "count", before: 0, after: (() => 1) as never }],
  });

  it("refuses a direct staged write whose diff cannot be recorded", async () => {
    const store = makeAdapter(
      {
        bump: (draft) => {
          draft.count = (draft.count as number) + 1;
        },
      },
      uncloneable(),
    );
    const runtime = startRuntime(store.adapter, [staged("bump_thing", "bump")]);
    await runtime.start();

    const result = await runtime.invoke("bump_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    // Nothing was dispatched, so no write landed and nothing is left open.
    expect(store.dispatches()).toBe(0);
    expect(store.liveState().count).toBe(0);
    expect(store.openArtifacts()).toEqual([]);
    expect(runtime.listUnreconciled()).toEqual([]);
  });

  it("refuses an approval request whose diff cannot be recorded", async () => {
    const store = makeAdapter(
      {
        bump: (draft) => {
          draft.count = (draft.count as number) + 1;
        },
      },
      uncloneable(),
    );
    const runtime = startRuntime(store.adapter, [
      staged("bump_thing", "bump", "CONSEQUENTIAL"),
    ]);
    await runtime.start();

    const result = await runtime.invoke("bump_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(store.dispatches()).toBe(0);
    expect(store.openArtifacts()).toEqual([]);
  });
});

describe("a resolution has to match the record it settles", () => {
  async function unknownCommit() {
    const store = incrementsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("bump_thing", "bump", "CONSEQUENTIAL"),
    ]);
    await runtime.start();
    await runtime.invoke("bump_thing", {});
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    return { store, runtime };
  }

  it("refuses a cleanup resolution for an unknown commit", async () => {
    const { store, runtime } = await unknownCommit();
    const [open] = runtime.listUnreconciled();

    const refused = runtime.reconcile(
      open!.id,
      { kind: "cleanup_disposed" },
      HUMAN,
    );

    expect(refused.ok).toBe(false);
    expect(store.resolutions()).toEqual([]);
    expect(runtime.listUnreconciled()).toHaveLength(1);
    expect(runtime.listUnreconciled()[0]?.changes).toEqual([
      { field: "count", before: 0, after: 1 },
    ]);
  });

  it("refuses a commit resolution for a failed cleanup", async () => {
    const store = makeAdapter(
      {
        bump: (draft) => {
          draft.count = (draft.count as number) + 1;
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
    const runtime = startRuntime(store.adapter, [staged("bump_thing", "bump")]);
    await runtime.start();
    await runtime.invoke("bump_thing", {});
    const [open] = runtime.listUnreconciled();
    expect(open?.kind).toBe("cleanup_failed");

    const refused = runtime.reconcile(
      open!.id,
      { kind: "commit_applied" },
      HUMAN,
    );

    expect(refused.ok).toBe(false);
    expect(store.resolutions()).toEqual([]);
    expect(runtime.listUnreconciled()).toHaveLength(1);
  });

  it("refuses a kind the vocabulary does not contain", async () => {
    const { store, runtime } = await unknownCommit();
    const [open] = runtime.listUnreconciled();

    const refused = runtime.reconcile(
      open!.id,
      { kind: "made_up" } as never,
      HUMAN,
    );

    expect(refused.ok).toBe(false);
    expect(store.resolutions()).toEqual([]);
    expect(runtime.listUnreconciled()).toHaveLength(1);
  });
});

describe("an indeterminate plan says so in the audit", () => {
  it("emits plan_indeterminate rather than plan_failed", async () => {
    const store = incrementsThenThrows();
    const runtime = startRuntime(store.adapter, [
      staged("bump_thing", "bump", "CONSEQUENTIAL"),
    ]);
    const seen: string[] = [];
    runtime.subscribeAudit((event) => seen.push(event.kind));
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [{ capability: "bump_thing", input: {} }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    await runtime.commitPlan(plan.id);

    expect(runtime.getPlan(plan.id)?.status).toBe("INDETERMINATE");
    expect(seen).toContain("plan_indeterminate");
    expect(seen).not.toContain("plan_failed");
  });
});

describe("startup checks every hook the runtime will need", () => {
  it("refuses an adapter with no reconcile hook", async () => {
    const store = makeAdapter({
      bump: (draft) => {
        draft.count = (draft.count as number) + 1;
      },
    });
    const withoutReconcile = { ...store.adapter } as Record<string, unknown>;
    delete withoutReconcile.reconcile;
    const registered: string[] = [];

    const runtime = createAgentDeskRuntime({
      capabilities: [staged("bump_thing", "bump")],
      registerTool: async (tool) => {
        registered.push(tool.name);
      },
      staging: withoutReconcile as never,
    });

    await expect(runtime.start()).rejects.toThrow(/reconcile/);
    expect(registered).toEqual([]);
  });
});
