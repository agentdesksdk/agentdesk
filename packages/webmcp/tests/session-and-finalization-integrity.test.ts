import { describe, expect, it } from "vitest";
import { defineCapability, type Capability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function gate() {
  let release!: () => void;
  let arrive!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  return {
    reached,
    release: () => release(),
    wait: async () => {
      arrive();
      await held;
    },
  };
}

function runtimeWith(capabilities: readonly Capability[]) {
  const model = createMockModelContext();
  return createAgentDeskRuntime({ registerTool: model.registerTool, capabilities });
}

const HUMAN = { id: "op", name: "Op", kind: "human" as const };
const writes = () =>
  defineCapability({
    name: "w",
    description: "Writes and returns a receipt",
    risk: "WRITE",
    execute: () =>
      receipt({
        entity: "Ledger",
        changes: [{ field: "value", before: 0, after: 1 }],
        result: { value: 1 },
      }),
  });
const consequential = (execute: () => unknown) =>
  defineCapability({
    name: "c",
    description: "Needs approval",
    risk: "CONSEQUENTIAL",
    approvalEvidence: "summary",
    execute,
  });

describe("finalization commits one outcome or none", () => {
  it("never records a write it cannot receipt", async () => {
    let ran = 0;
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Writes and returns a receipt",
        risk: "WRITE",
        execute: () => {
          ran += 1;
          return receipt({
            entity: "Ledger",
            changes: [{ field: "value", before: 0, after: 1 }],
            result: { value: 1 },
          });
        },
      }),
    ]);
    await runtime.start();

    const outcome = await runtime.invoke("w", { bad: () => "uncloneable" });

    // Either the write happened and is receipted, or it never happened.
    // Succeeding with no receipt loses the evidence; failing after the
    // handler ran reports a rollback that did not occur.
    expect({ ran, failed: outcome.isError === true, receipts: runtime.queryReceipts().length })
      .toEqual({ ran: 0, failed: true, receipts: 0 });
  });

  it("never records one execution as both completed and failed", async () => {
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Returns a value JSON cannot serialize",
        risk: "WRITE",
        execute: () =>
          receipt({
            entity: "Ledger",
            changes: [{ field: "value", before: 0, after: 1 }],
            result: { amount: 1n },
          }),
      }),
    ]);
    await runtime.start();

    await runtime.invoke("w", {});

    const terminal = new Map<string, string[]>();
    for (const event of runtime.getSnapshot().audit) {
      if (event.kind !== "execution_completed" && event.kind !== "execution_failed") continue;
      const id = (event as { executionId: string }).executionId;
      terminal.set(id, [...(terminal.get(id) ?? []), event.kind]);
    }
    expect([...terminal.values()].filter((kinds) => kinds.length > 1)).toEqual([]);
  });
});

describe("one session claim covers a whole operation", () => {
  it("drops an execution whose verification outlives the session", async () => {
    const held = gate();
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Writes, then verifies slowly",
        risk: "WRITE",
        verify: async () => {
          await held.wait();
          return { status: "VERIFIED" };
        },
        execute: () =>
          receipt({
            entity: "Ledger",
            changes: [{ field: "value", before: 0, after: 1 }],
            result: { value: 1 },
          }),
      }),
    ]);
    await runtime.start();

    const call = runtime.invoke("w", {});
    await held.reached;
    await runtime.reset();
    held.release();
    await call;

    expect({
      audit: runtime.getSnapshot().audit.length,
      receipts: runtime.queryReceipts().length,
    }).toEqual({ audit: 0, receipts: 0 });
  });

  it("stops a plan at the operation the reset interrupted", async () => {
    const held = gate();
    const ran: string[] = [];
    const runtime = runtimeWith([
      defineCapability({
        name: "one",
        description: "Blocks until released",
        risk: "WRITE",
        execute: async () => {
          ran.push("one");
          await held.wait();
          return "1";
        },
      }),
      defineCapability({
        name: "two",
        description: "Must never run after a reset",
        risk: "WRITE",
        execute: () => {
          ran.push("two");
          return "2";
        },
      }),
    ]);
    await runtime.start();

    const plan = await runtime.prepare({
      operations: [{ capability: "one" }, { capability: "two" }],
    });
    runtime.approvePlan(plan.id);
    const committing = runtime.commitPlan(plan.id);
    await held.reached;
    await runtime.reset();
    held.release();
    await committing;

    expect(ran).toEqual(["one"]);
    expect(runtime.getSnapshot().audit).toEqual([]);
  });

  it("does not resurrect an approval the reset cleared", async () => {
    const held = gate();
    const runtime = runtimeWith([
      consequential(async () => {
        await held.wait();
        return "done";
      }),
    ]);
    await runtime.start();
    await runtime.invoke("c", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    const approving = runtime.approve(id, HUMAN);
    await held.reached;
    await runtime.reset();
    held.release();
    await approving;

    const status = await runtime.invoke("get_action_status", { approval_id: id });
    expect(status.content?.[0]?.text ?? "").toContain("unknown");
  });
});

describe("interrupted work is representable", () => {
  it("does not strand a plan in COMMITTING after stop", async () => {
    const held = gate();
    const runtime = runtimeWith([
      defineCapability({
        name: "one",
        description: "Blocks until released",
        risk: "WRITE",
        execute: async () => {
          await held.wait();
          return "1";
        },
      }),
    ]);
    await runtime.start();
    const plan = await runtime.prepare({ operations: [{ capability: "one" }] });
    runtime.approvePlan(plan.id);
    const committing = runtime.commitPlan(plan.id);
    await held.reached;
    await runtime.stop();
    held.release();
    await committing;

    expect(runtime.getPlan(plan.id)?.status).not.toBe("COMMITTING");
  });

  it("does not strand a rollback in ROLLING_BACK after stop", async () => {
    const held = gate();
    const store = { value: 0 };
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Sets the value to 1",
        risk: "WRITE",
        rollback: async (_i, _c, changes) => {
          await held.wait();
          store.value = changes[0]?.before as number;
          return { restored: true };
        },
        execute: () => {
          const before = store.value;
          store.value = 1;
          return receipt({
            entity: "Ledger",
            changes: [{ field: "value", before, after: 1 }],
            undoable: true,
            result: { value: 1 },
          });
        },
      }),
    ]);
    await runtime.start();
    await runtime.invoke("w", {});
    const id = runtime.queryReceipts()[0]!.id;

    const undoing = runtime.rollback(id);
    await held.reached;
    await runtime.stop();
    held.release();
    await undoing;

    await runtime.start();
    const retry = await runtime.rollback(id);
    expect(retry.ok ? "ran" : retry.reason).not.toMatch(/already being rolled back/);
  });

  it("does not create a plan when a preview callback ends the session", async () => {
    let runtime: ReturnType<typeof runtimeWith>;
    const capability = defineCapability({
      name: "w",
      description: "Previews by ending the session",
      risk: "WRITE",
      previewChanges: () => {
        void runtime.reset();
        return [{ field: "value", before: 0, after: 1 }];
      },
      execute: () => "done",
    });
    runtime = runtimeWith([capability]);
    await runtime.start();

    await expect(
      runtime.prepare({ operations: [{ capability: "w" }] }),
    ).rejects.toThrow(/reset while this plan was being prepared/);
    await new Promise((r) => setTimeout(r, 0));

    expect({
      plans: runtime.listPlans().length,
      audit: runtime.getSnapshot().audit.length,
    }).toEqual({ plans: 0, audit: 0 });
  });
});

describe("a human identity is normalized once, then trusted", () => {
  it("cannot validate as human and be stored as an agent", async () => {
    let reads = 0;
    const shifting = {
      id: "x",
      name: "X",
      get kind() {
        return ++reads === 1 ? "human" : "agent";
      },
    };
    const runtime = runtimeWith([consequential(() => "done")]);
    await runtime.start();
    await runtime.invoke("c", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    await runtime.approve(id, shifting as never);

    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "approval_approved") as
      | { approvedBy?: { kind: string } }
      | undefined;
    expect(event?.approvedBy?.kind ?? "refused").not.toBe("agent");
  });

  it("refuses an identity it cannot copy instead of throwing", async () => {
    const runtime = runtimeWith([consequential(() => "done")]);
    await runtime.start();
    await runtime.invoke("c", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    const result = await runtime.approve(id, {
      id: "x",
      name: "X",
      kind: "human",
      onDone: () => {},
    } as never);

    expect(result.isError).toBe(true);
  });
});
