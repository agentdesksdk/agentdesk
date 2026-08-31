import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type Capability,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

type Doc = Record<string, string>;

/**
 * An honest application adapter, plus counters for what the runtime did to
 * the artifacts it produced. `released` is the assertion that matters for a
 * leak: a fork that is neither committed nor released is unreachable.
 */
function makeAdapter(
  overrides: Partial<StagingAdapter<Artifact>> = {},
): {
  adapter: StagingAdapter<Artifact>;
  draft: () => Doc;
  committedState: () => Doc;
  openArtifacts: () => Artifact[];
  releases: () => number;
} {
  let live: Doc = { status: "safe" };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  let releases = 0;

  const base: StagingAdapter<Artifact> = {
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
    fork(capability, write) {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      const before = { ...open };
      const result = write();
      const artifact: Artifact = {
        name: capability,
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
        changes: [],
        undoable: false,
        result: { ...artifact.head },
      });
    },
    release: (artifact) => {
      releases += 1;
      artifact.settled = true;
    },
  };

  return {
    adapter: { ...base, ...overrides },
    draft: () => {
      if (open === null) {
        throw new Error("no fork is open");
      }
      return open;
    },
    committedState: () => ({ ...live }),
    openArtifacts: () => artifacts.filter((artifact) => !artifact.settled),
    releases: () => releases,
  };
}

type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };

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

describe("a capability cannot supply its own evidence adapter", () => {
  it("refuses a capability that declares an adapter beside its write", () => {
    const honest = makeAdapter();
    expect(() =>
      defineCapability({
        name: "byo_adapter",
        description: "Brings its own staging adapter.",
        risk: "CONSEQUENTIAL",
        // The public spec carries only `write`, so this is the only way a
        // JavaScript caller could reach an adapter of its own.
        staging: {
          adapter: honest.adapter,
          write: () => undefined,
        },
      } as never),
    ).toThrow(/adapter/);
  });

  it("derives the card from the runtime's adapter, not the capability's", async () => {
    const trusted = makeAdapter();
    const runtime = startRuntime(trusted.adapter, [
      defineCapability({
        name: "two_faced",
        description: "Writes one thing and would rather report another.",
        risk: "CONSEQUENTIAL",
        staging: {
          write: () => {
            trusted.draft().status = "deleted-everything";
          },
        },
      }),
    ]);
    await runtime.start();

    const requested = await runtime.invoke("two_faced", {});

    expect(requested.data?.approvalEvidence).toBe("derived");
    // What the card shows is what the fork recorded, so it names the write
    // that will actually land.
    expect(requested.data?.will_change).toEqual([
      { field: "status", before: "safe", after: "deleted-everything" },
    ]);

    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    expect(trusted.committedState()).toEqual({ status: "deleted-everything" });
  });

  it("refuses to start when a staged capability has no runtime adapter", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities: [
        defineCapability({
          name: "unbacked",
          description: "Stages with no adapter configured.",
          risk: "CONSEQUENTIAL",
          staging: { write: () => undefined },
        }),
      ],
      registerTool: async () => {},
    });

    await expect(runtime.start()).rejects.toThrow(/staging adapter/);
  });
});

describe("a failed staging releases its artifact exactly once", () => {
  const stagedCapability = (write: () => unknown): Capability =>
    defineCapability({
      name: "touch_thing",
      description: "Stages a write.",
      risk: "CONSEQUENTIAL",
      staging: { write },
    });

  it("releases when diff throws", async () => {
    const store = makeAdapter({
      diff: () => {
        throw new Error("cannot describe this");
      },
    });
    const runtime = startRuntime(store.adapter, [
      stagedCapability(() => {
        store.draft().status = "touched";
      }),
    ]);
    await runtime.start();

    const result = await runtime.invoke("touch_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("releases when diff returns something that is not a diff", async () => {
    const store = makeAdapter({
      diff: () => undefined as never,
    });
    const runtime = startRuntime(store.adapter, [
      stagedCapability(() => {
        store.draft().status = "touched";
      }),
    ]);
    await runtime.start();

    const result = await runtime.invoke("touch_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("releases when the staged write suspends", async () => {
    const store = makeAdapter();
    const runtime = startRuntime(store.adapter, [
      stagedCapability(() => Promise.resolve({ done: true })),
    ]);
    await runtime.start();

    const result = await runtime.invoke("touch_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("releases when commit throws before consuming the artifact", async () => {
    const store = makeAdapter({
      commit: () => {
        throw new Error("could not land it");
      },
    });
    const runtime = startRuntime(store.adapter, [
      stagedCapability(() => {
        store.draft().status = "touched";
      }),
    ]);
    await runtime.start();
    await runtime.invoke("touch_thing", {});

    const approved = await runtime.approve(
      runtime.getSnapshot().pending[0]!.id,
      HUMAN,
    );

    expect(approved.content[0]?.text ?? "").toContain("could not land it");
    expect(store.committedState()).toEqual({ status: "safe" });
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("keeps the original failure when cleanup also throws", async () => {
    let releases = 0;
    const store = makeAdapter({
      diff: () => {
        throw new Error("cannot describe this");
      },
      release: () => {
        releases += 1;
        throw new Error("cleanup exploded");
      },
    });
    const runtime = startRuntime(store.adapter, [
      stagedCapability(() => {
        store.draft().status = "touched";
      }),
    ]);
    await runtime.start();

    const result = await runtime.invoke("touch_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    // The reason a human reads is why staging failed, not why the cleanup
    // after it failed.
    expect(
      `${JSON.stringify(result.data)}${result.content[0]?.text ?? ""}`,
    ).toContain("cannot describe this");
    expect(releases).toBe(1);
  });
});
