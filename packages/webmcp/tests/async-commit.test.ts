import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  StagedCommitRefused,
  type Capability,
  type StagingAdapter,
} from "../src/index.ts";

const AGENT = { id: "agent", name: "Agent", kind: "agent" as const };

type Doc = Record<string, unknown>;
type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };

/**
 * An adapter whose store is asynchronous: commit and release return
 * promises that settle on a later macrotask, the way a database does, so
 * whatever the runtime records before they settle is recorded too early.
 */
function makeAsyncAdapter(options: {
  commit?: "resolves" | "refuses" | "drops";
  release?: "resolves" | "rejects";
} = {}) {
  let live: Doc = { count: 0 };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  let releases = 0;
  let dispatches = 0;
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const adapter: StagingAdapter<Artifact> = {
    operations: new Set(["bump"]),
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
      open.count = Number(open.count ?? 0) + 1;
      const artifact: Artifact = { name: operation, before, head: { ...open }, settled: false };
      if (outermost) {
        open = null;
      }
      artifacts.push(artifact);
      return { staged: artifact, result: { count: artifact.head.count } };
    },
    diff: (artifact) =>
      Object.keys(artifact.head)
        .filter((key) => artifact.before[key] !== artifact.head[key])
        .map((key) => ({ field: key, before: artifact.before[key] ?? null, after: artifact.head[key] })),
    commit: async (artifact) => {
      await later();
      if (options.commit === "refuses") {
        throw new StagedCommitRefused("the row moved under this fork");
      }
      dispatches += 1;
      live = { ...live, ...artifact.head };
      if (options.commit === "drops") {
        throw new Error("the connection dropped after the write was sent");
      }
      artifact.settled = true;
      return receipt({ entity: artifact.name, changes: adapter.diff(artifact), result: { ...artifact.head } });
    },
    release: async (artifact) => {
      await later();
      if (options.release === "rejects") {
        throw new Error("the fork could not be dropped");
      }
      releases += 1;
      artifact.settled = true;
    },
    reconcile: (artifact) => {
      artifact.settled = true;
    },
  };

  return {
    adapter,
    liveState: () => ({ ...live }),
    releases: () => releases,
    dispatches: () => dispatches,
  };
}

const bumpThing: Capability = defineCapability({
  name: "bump_thing",
  description: "Stages bump.",
  risk: "WRITE",
  staging: { operation: "bump" },
});

const approveThing: Capability = defineCapability({
  name: "approve_thing",
  description: "Stages bump behind an approval.",
  risk: "CONSEQUENTIAL",
  staging: { operation: "bump" },
});

async function boot(adapter: StagingAdapter<Artifact>) {
  const runtime = createAgentDeskRuntime({
    capabilities: [bumpThing, approveThing],
    registerTool: async () => {},
    actor: AGENT,
    staging: adapter,
  });
  await runtime.start();
  return runtime;
}

const kinds = (runtime: Awaited<ReturnType<typeof boot>>) =>
  runtime.getSnapshot().audit.map((event) => event.kind);

describe("a staged commit may be asynchronous", () => {
  it("is awaited, so the outcome is recorded after the write and not before", async () => {
    const store = makeAsyncAdapter({ commit: "resolves" });
    const runtime = await boot(store.adapter);

    const result = await runtime.invoke("bump_thing", {});

    expect(result.isError).toBeFalsy();
    // The write had landed by the time the result came back, not later.
    expect(store.liveState()).toEqual({ count: 1 });
    expect(result.data?.receipt).toMatchObject({ entity: "bump" });
    expect(kinds(runtime)).toContain("execution_completed");
  });

  it("treats a rejection that names a refusal as a refusal, before any write", async () => {
    const store = makeAsyncAdapter({ commit: "refuses" });
    const runtime = await boot(store.adapter);

    const result = await runtime.invoke("bump_thing", {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.isError).toBe(true);
    expect(store.liveState()).toEqual({ count: 0 });
    expect(store.dispatches()).toBe(0);
    expect(kinds(runtime)).toContain("execution_failed");
    expect(kinds(runtime)).not.toContain("execution_completed");
    expect(runtime.listUnreconciled()).toEqual([]);
    // The refused fork is released, as a synchronous refusal's is.
    expect(store.releases()).toBe(1);
  });

  it("treats any other rejection as indeterminate, keeping the record and the artifact", async () => {
    const store = makeAsyncAdapter({ commit: "drops" });
    const runtime = await boot(store.adapter);

    const result = await runtime.invoke("bump_thing", {});

    expect(result.code).toBe("EXECUTION_INDETERMINATE");
    expect(kinds(runtime)).not.toContain("execution_completed");
    const [record] = runtime.listUnreconciled();
    expect(record).toMatchObject({
      kind: "commit_indeterminate",
      capability: "bump_thing",
      changes: [{ field: "count", before: 0, after: 1 }],
    });
    expect(store.releases()).toBe(0);

    const again = await runtime.invoke("bump_thing", {});
    expect(again.code).toBe("EXECUTION_INDETERMINATE");
    expect(store.dispatches()).toBe(1);
  });

  it("records a release that rejects as a failed cleanup and keeps the artifact", async () => {
    const store = makeAsyncAdapter({ release: "rejects" });
    const runtime = await boot(store.adapter);
    await runtime.invoke("approve_thing", {});
    const [pending] = runtime.getSnapshot().pending;

    runtime.reject(pending!.id, { id: "operator-1", name: "Amein", kind: "human" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [record] = runtime.listUnreconciled();
    expect(record).toMatchObject({ kind: "cleanup_failed", capability: "approve_thing" });
    expect(kinds(runtime)).toContain("staged_cleanup_failed");
    expect(store.releases()).toBe(0);
  });
});
