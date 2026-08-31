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
type Artifact = { name: string; before: Doc; head: Doc; settled: boolean };

/**
 * An adapter that owns its operations. A capability names one and supplies
 * input; it never hands over code, so nothing it declares can reach live
 * state outside a fork.
 */
function makeAdapter(
  operations: Record<string, (draft: Doc, input: Record<string, unknown>) => void>,
  overrides: Partial<StagingAdapter<Artifact>> = {},
) {
  let live: Doc = { status: "safe" };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  let releases = 0;

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
    fork(operation, input) {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      const before = { ...open };
      const result = operations[operation]!(open, input);
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
    liveState: () => ({ ...live }),
    setLive: (next: Doc) => {
      live = next;
    },
    openArtifacts: () => artifacts.filter((artifact) => !artifact.settled),
    releases: () => releases,
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

describe("a capability cannot supply executable code to stage", () => {
  it("refuses a capability that declares a write closure", () => {
    expect(() =>
      defineCapability({
        name: "byo_write",
        description: "Brings its own staged write.",
        risk: "CONSEQUENTIAL",
        // The public spec carries only an operation name, so this is the
        // only way a JavaScript caller could hand over code.
        staging: { write: () => undefined },
      } as never),
    ).toThrow(/only names an operation/);
  });

  it("refuses a capability that declares an adapter", () => {
    const store = makeAdapter({ noop: () => {} });
    expect(() =>
      defineCapability({
        name: "byo_adapter",
        description: "Brings its own staging adapter.",
        risk: "CONSEQUENTIAL",
        staging: { operation: "noop", adapter: store.adapter },
      } as never),
    ).toThrow(/only names an operation/);
  });

  it("refuses a capability that declares no operation name", () => {
    expect(() =>
      defineCapability({
        name: "no_operation",
        description: "Stages nothing in particular.",
        risk: "CONSEQUENTIAL",
        staging: {},
      } as never),
    ).toThrow(/without an operation name/);
  });

  it("refuses to start when a capability names an operation the adapter has not got", async () => {
    const store = makeAdapter({ known: (draft) => {
      draft.status = "known";
    } });
    const runtime = startRuntime(store.adapter, [
      staged("unknown_op", "does_not_exist"),
    ]);

    await expect(runtime.start()).rejects.toThrow(/does_not_exist/);
  });

  it("leaves live state untouched while an approval is pending", async () => {
    const store = makeAdapter({
      cancel: (draft) => {
        draft.status = "cancelled";
      },
    });
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();

    const requested = await runtime.invoke("cancel_thing", {});

    expect(requested.code).toBe("APPROVAL_REQUIRED");
    expect(requested.data?.approvalEvidence).toBe("derived");
    // The write ran only against the fork, so the document a human is
    // looking at has not moved.
    expect(store.liveState()).toEqual({ status: "safe" });
    expect(requested.data?.will_change).toEqual([
      { field: "status", before: "safe", after: "cancelled" },
    ]);
  });
});

describe("a commit that throws after dispatch is indeterminate", () => {
  const landsThenThrows = () =>
    makeAdapter(
      {
        cancel: (draft) => {
          draft.status = "cancelled";
        },
      },
      {
        commit: (artifact: Artifact) => {
          // The write reaches live state and the acknowledgement fails, so
          // the exception says nothing about whether it landed.
          store.setLive({ ...store.liveState(), ...artifact.head });
          throw new Error("commit acknowledgement failed");
        },
      },
    );
  let store: ReturnType<typeof makeAdapter>;

  it("records the approval as indeterminate rather than failed", async () => {
    store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;

    await runtime.approve(actionId, HUMAN);

    const status = await runtime.invoke("get_action_status", {
      approval_id: actionId,
    });
    const reported = JSON.parse(status.content[0]!.text!) as {
      status: string;
      detail: string;
    };
    expect(reported.status).toBe("INDETERMINATE");
    expect(reported.detail).toContain("commit acknowledgement failed");
  });

  it("keeps the approved diff as evidence for reconciliation", async () => {
    store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;

    await runtime.approve(actionId, HUMAN);

    const unreconciled = runtime.listUnreconciled();
    expect(unreconciled).toHaveLength(1);
    expect(unreconciled[0]?.actionId).toBe(actionId);
    expect(unreconciled[0]?.changes).toEqual([
      { field: "status", before: "safe", after: "cancelled" },
    ]);
    // The write did land, and the record is what lets a human find that out.
    expect(store.liveState()).toEqual({ status: "cancelled" });
  });

  it("refuses to run again while the outcome is unknown", async () => {
    store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, HUMAN);

    const retry = await runtime.approve(actionId, HUMAN);

    expect(
      `${JSON.stringify(retry.data)}${retry.content[0]?.text ?? ""}`,
    ).toContain("INDETERMINATE");
    expect(runtime.listUnreconciled()).toHaveLength(1);
  });

  it("closes out once a human reconciles it", async () => {
    store = landsThenThrows();
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();
    await runtime.invoke("cancel_thing", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, HUMAN);

    const settled = runtime.reconcile(actionId, "applied", HUMAN);

    expect(settled.ok).toBe(true);
    expect(runtime.listUnreconciled()).toHaveLength(0);
  });
});

describe("a cleanup that fails is observable", () => {
  it("reports the staging failure and the failed disposal, and retains the artifact", async () => {
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
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();

    const result = await runtime.invoke("cancel_thing", {});

    // The staging failure is still what the caller is told.
    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(
      `${JSON.stringify(result.data)}${result.content[0]?.text ?? ""}`,
    ).toContain("cannot describe this");

    // Invoking a hook that throws does not dispose anything, so the artifact
    // is still open and has to be recoverable rather than forgotten.
    expect(store.openArtifacts()).toHaveLength(1);
    const unreconciled = runtime.listUnreconciled();
    expect(unreconciled).toHaveLength(1);
    expect(unreconciled[0]?.detail).toContain("cleanup exploded");
  });

  it("releases when the diff is not a diff", async () => {
    const store = makeAdapter(
      { cancel: (draft) => {
        draft.status = "cancelled";
      } },
      { diff: () => undefined as never },
    );
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();

    const result = await runtime.invoke("cancel_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("releases when the staged operation suspends", async () => {
    const store = makeAdapter({
      cancel: () => Promise.resolve({ done: true }) as never,
    });
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();

    const result = await runtime.invoke("cancel_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
  });

  it("disposes cleanly when release succeeds", async () => {
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
      },
    );
    const runtime = startRuntime(store.adapter, [staged("cancel_thing", "cancel")]);
    await runtime.start();

    const result = await runtime.invoke("cancel_thing", {});

    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(store.openArtifacts()).toEqual([]);
    expect(store.releases()).toBe(1);
    expect(runtime.listUnreconciled()).toHaveLength(0);
  });
});
