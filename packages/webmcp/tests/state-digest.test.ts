import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type Capability,
  type StagingAdapter,
  type ToolResult,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

type Doc = Record<string, string>;

/**
 * An application store behind a staging adapter, with a way to move live
 * state under a pending approval, so "the base drifted" and "something
 * unrelated moved" are single calls.
 */
function makeStore(initial: Doc) {
  let live: Doc = { ...initial };
  let open: Doc | null = null;
  let committed = 0;

  type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };
  const artifacts: Artifact[] = [];
  const registry = new Map<string, (draft: Doc) => void>();

  const openFork = (): { outermost: boolean } => {
    const outermost = open === null;
    if (open === null) {
      open = { ...live };
    }
    return { outermost };
  };

  const adapter: StagingAdapter<Artifact> = {
    get operations() {
      return new Set(registry.keys());
    },
    scope: (run) => {
      const { outermost } = openFork();
      try {
        return run();
      } finally {
        if (outermost) {
          open = null;
        }
      }
    },
    fork(operation) {
      const { outermost } = openFork();
      const before = { ...open! };
      const result = registry.get(operation)!(open!);
      const artifact: Artifact = {
        name: operation,
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
          // A digest handed in by the adapter's own diff must be ignored.
          stateVersion: "forged-by-adapter",
        })),
    commit: (artifact) => {
      artifact.settled = true;
      committed += 1;
      // Lands only what the staged run changed, so an unrelated field a
      // person moved meanwhile is not overwritten by the fork's copy of it.
      const landed = { ...live };
      for (const change of adapter.diff(artifact)) {
        landed[change.field] = artifact.head[change.field]!;
      }
      live = landed;
      return receipt({
        entity: artifact.name,
        changes: adapter.diff(artifact),
        result: { ...artifact.head },
      });
    },
    release: (artifact) => {
      artifact.settled = true;
    },
    reconcile: (artifact) => {
      artifact.settled = true;
    },
  };

  return {
    adapter,
    register: (operation: string, write: (draft: Doc) => void) => {
      registry.set(operation, write);
    },
    /** Moves live state under whatever is pending. */
    mutate: (key: string, value: string) => {
      live = { ...live, [key]: value };
    },
    read: (key: string) => live[key],
    commitCount: () => committed,
    liveProposals: () => artifacts.filter((artifact) => !artifact.settled),
    committedState: () => ({ ...live }),
  };
}

type Store = ReturnType<typeof makeStore>;

function staged(store: Store, name: string, write: (draft: Doc) => void): Capability {
  store.register(name, write);
  return defineCapability({
    name,
    description: `Stages ${name}.`,
    risk: "CONSEQUENTIAL",
    staging: { operation: name },
  });
}

function boot(store: Store, capabilities: Capability[]) {
  return createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    staging: store.adapter,
  });
}

function pendingId(runtime: ReturnType<typeof boot>): string {
  return runtime.getSnapshot().pending[0]!.id;
}

function startedCount(runtime: ReturnType<typeof boot>): number {
  return runtime
    .getSnapshot()
    .audit.filter((event) => event.kind === "execution_started").length;
}

describe("approval bound to a state digest: a staged approval", () => {
  it("carries a stateVersion the runtime computed, not one the adapter handed in", async () => {
    const store = makeStore({ status: "processing", notes: "" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();

    const requested = await runtime.invoke("cancel_thing", { id: "T-1" });

    expect(requested.code).toBe("APPROVAL_REQUIRED");
    expect(typeof requested.data?.stateVersion).toBe("string");
    expect(requested.data?.stateVersion).not.toBe("forged-by-adapter");
    expect(runtime.getSnapshot().pending[0]?.stateVersion).toBe(requested.data?.stateVersion);
  });

  it("refuses to commit when the base moved, and writes nothing", async () => {
    const store = makeStore({ status: "processing", notes: "" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();
    const requested = await runtime.invoke("cancel_thing", { id: "T-1" });
    const actionId = pendingId(runtime);

    store.mutate("status", "on_hold");
    const result = await runtime.approve(actionId, HUMAN);

    expect(result.code).toBe("APPROVAL_STALE");
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      status: "APPROVAL_STALE",
      capability: "cancel_thing",
      approval_id: actionId,
      reasonCode: "APPROVAL_STALE",
      requiresNewPreview: true,
      repair: { capability: "cancel_thing", input: { id: "T-1" } },
      evidence: [{ kind: "approval", id: actionId }],
    });
    const versions = result.data?.stateVersion as { expected: string; observed: string };
    expect(versions.expected).toBe(requested.data?.stateVersion);
    expect(versions.observed).not.toBe(versions.expected);
    expect(result.data).not.toHaveProperty("changes");
    expect(store.read("status")).toBe("on_hold");
    expect(store.commitCount()).toBe(0);
    expect(store.liveProposals()).toEqual([]);
    expect(startedCount(runtime)).toBe(0);
    const status = (await runtime.invoke("get_action_status", {
      approval_id: actionId,
    })) as ToolResult;
    expect(JSON.parse(status.content[0]!.text)).toMatchObject({
      status: "FAILED_UNAVAILABLE",
      reasonCode: "APPROVAL_STALE",
    });
  });

  it("commits when only unrelated state moved", async () => {
    const store = makeStore({ status: "processing", notes: "" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", { id: "T-1" });
    const actionId = pendingId(runtime);

    store.mutate("notes", "customer called");
    const result = await runtime.approve(actionId, HUMAN);

    expect(result.data?.status).toBe("COMPLETED");
    expect(store.committedState()).toEqual({ status: "cancelled", notes: "customer called" });
    expect(store.commitCount()).toBe(1);
    expect(startedCount(runtime)).toBe(1);
  });

  it("commits exactly once on unchanged state, even under concurrent approvals", async () => {
    const store = makeStore({ status: "processing", notes: "" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();
    await runtime.invoke("cancel_thing", { id: "T-1" });
    const actionId = pendingId(runtime);

    const [a, b] = await Promise.all([
      runtime.approve(actionId, HUMAN),
      runtime.approve(actionId, HUMAN),
    ]);

    const statuses = [a, b].map((result) => result.data?.status);
    expect(statuses).toContain("COMPLETED");
    expect(store.commitCount()).toBe(1);
    expect(startedCount(runtime)).toBe(1);
    expect(store.read("status")).toBe("cancelled");
  });

  it("gives the same digest for the same state and a different one after a move", async () => {
    const store = makeStore({ status: "processing", notes: "" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();

    const first = await runtime.invoke("cancel_thing", { id: "T-1" });
    const second = await runtime.invoke("cancel_thing", { id: "T-2" });
    store.mutate("status", "on_hold");
    const moved = await runtime.invoke("cancel_thing", { id: "T-3" });

    expect(first.data?.stateVersion).toBe(second.data?.stateVersion);
    expect(moved.data?.stateVersion).not.toBe(first.data?.stateVersion);
  });
});

describe("approval bound to a state digest: an author-written preview", () => {
  function ledger() {
    const state = { balance: 100, note: "" };
    let executed = 0;
    const capability = defineCapability({
      name: "debit_account",
      description: "Debits the account.",
      risk: "CONSEQUENTIAL",
      previewChanges: () => [
        {
          field: "balance",
          before: state.balance,
          after: state.balance - 10,
          // A digest handed in by the author's preview must be ignored.
          stateVersion: "forged-by-author",
        } as never,
      ],
      execute: () => {
        executed += 1;
        state.balance -= 10;
        return receipt({
          entity: "account",
          changes: [{ field: "balance", before: state.balance + 10, after: state.balance }],
          result: { balance: state.balance },
        });
      },
    });
    return { state, capability, executed: () => executed };
  }

  it("shares the digest with staged approvals and refuses on drift the same way", async () => {
    const account = ledger();
    const runtime = createAgentDeskRuntime({
      capabilities: [account.capability],
      registerTool: async () => {},
    });
    await runtime.start();
    const requested = await runtime.invoke("debit_account", {});
    const actionId = pendingId(runtime);
    expect(typeof requested.data?.stateVersion).toBe("string");
    expect(requested.data?.stateVersion).not.toBe("forged-by-author");

    account.state.balance = 50;
    const result = await runtime.approve(actionId, HUMAN);

    expect(result.code).toBe("APPROVAL_STALE");
    expect(result.data?.requiresNewPreview).toBe(true);
    expect(account.executed()).toBe(0);
    expect(account.state.balance).toBe(50);
  });

  it("commits when the unrelated field moved", async () => {
    const account = ledger();
    const runtime = createAgentDeskRuntime({
      capabilities: [account.capability],
      registerTool: async () => {},
    });
    await runtime.start();
    await runtime.invoke("debit_account", {});
    const actionId = pendingId(runtime);

    account.state.note = "moved";
    const result = await runtime.approve(actionId, HUMAN);

    expect(result.data?.status).toBe("COMPLETED");
    expect(account.executed()).toBe(1);
    expect(account.state.balance).toBe(90);
  });

  it("a summary-only approval has no digest to check and no stateVersion", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities: [
        defineCapability({
          name: "wipe_cache",
          description: "Wipes the cache.",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: () => "wiped",
        }),
      ],
      registerTool: async () => {},
    });
    await runtime.start();

    const requested = await runtime.invoke("wipe_cache", {});

    expect(requested.code).toBe("APPROVAL_REQUIRED");
    expect(requested.data).not.toHaveProperty("stateVersion");
    expect(runtime.getSnapshot().pending[0]).not.toHaveProperty("stateVersion");
  });
});

describe("approval bound to a state digest: a plan", () => {
  it("refuses only the operation whose base drifted", async () => {
    const store = makeStore({ a: "0", b: "0" });
    const runtime = boot(store, [
      staged(store, "touch_a", (draft) => {
        draft.a = "1";
      }),
      staged(store, "touch_b", (draft) => {
        draft.b = "1";
      }),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [{ capability: "touch_a" }, { capability: "touch_b" }],
    });
    expect(plan.operations.map((operation) => typeof operation.stateVersion)).toEqual([
      "string",
      "string",
    ]);
    runtime.approvePlan(plan.id, HUMAN);

    store.mutate("b", "9");
    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(false);
    const outcomes = runtime.getPlan(plan.id)!.outcomes!;
    expect(outcomes[0]).toMatchObject({ capability: "touch_a", status: "COMPLETED" });
    expect(outcomes[1]).toMatchObject({ capability: "touch_b", status: "SKIPPED" });
    expect(outcomes[1]!.detail).toContain("APPROVAL_STALE");
    expect(runtime.getPlan(plan.id)!.status).toBe("PARTIAL");
    expect(store.committedState()).toEqual({ a: "1", b: "9" });
    expect(store.liveProposals()).toEqual([]);
  });

  it("commits every operation when nothing it read moved", async () => {
    const store = makeStore({ a: "0", b: "0", unrelated: "0" });
    const runtime = boot(store, [
      staged(store, "touch_a", (draft) => {
        draft.a = "1";
      }),
      staged(store, "touch_b", (draft) => {
        draft.b = "1";
      }),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({
      operations: [{ capability: "touch_a" }, { capability: "touch_b" }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    store.mutate("unrelated", "9");
    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(true);
    expect(store.committedState()).toEqual({ a: "1", b: "1", unrelated: "9" });
    expect(store.commitCount()).toBe(2);
  });
});

describe("approval bound to a state digest: a grant-authorized execution", () => {
  it("has no preview, so it carries no stateVersion and checks no digest", async () => {
    const store = makeStore({ status: "processing" });
    const runtime = boot(store, [
      staged(store, "cancel_thing", (draft) => {
        draft.status = "cancelled";
      }),
    ]);
    await runtime.start();
    runtime.grant(
      { capability: "cancel_thing", uses: 1, expiresAt: Date.now() + 60_000 },
      HUMAN,
    );

    const done = await runtime.invoke("cancel_thing", { id: "T-1" });

    expect(done.data?.status).toBe("COMPLETED");
    expect(done.data).not.toHaveProperty("stateVersion");
    expect(store.commitCount()).toBe(1);
  });
});
