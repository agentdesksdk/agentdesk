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
  return createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities,
    actor: { id: "agent", name: "Agent", kind: "agent" },
  });
}

describe("a completed execution is never also reported as failed", () => {
  it("refuses input it cannot record before recording anything", async () => {
    const runtime = runtimeWith([
      defineCapability({
        name: "set_value",
        description: "Writes and returns a receipt",
        risk: "WRITE",
        execute: () =>
          receipt({
            entity: "Ledger",
            changes: [{ field: "value", before: 0, after: 1 }],
            result: { value: 1 },
          }),
      }),
    ]);
    await runtime.start();

    const outcome = await runtime.invoke("set_value", { onDone: () => "not cloneable" });

    // This input used to run the write and then fail recording it, which is
    // how one execution ended up both completed and failed. It is refused at
    // the boundary now, so there is no execution to contradict.
    expect(outcome.isError).toBe(true);
    expect(
      runtime
        .getSnapshot()
        .audit.filter((e) => e.kind.startsWith("execution_")),
    ).toEqual([]);
    expect(runtime.queryReceipts()).toEqual([]);
  });
});

describe("reset is a session boundary that in-flight work cannot cross", () => {
  it("drops a plan commit that resolves after reset", async () => {
    const held = gate();
    const runtime = runtimeWith([
      defineCapability({
        name: "slow_plan_write",
        description: "Blocks until released",
        risk: "WRITE",
        execute: async () => {
          await held.wait();
          return "done";
        },
      }),
    ]);
    await runtime.start();

    const plan = await runtime.prepare({
      operations: [{ capability: "slow_plan_write" }],
    });
    runtime.approvePlan(plan.id);
    const committing = runtime.commitPlan(plan.id);
    await held.reached;
    await runtime.reset();
    held.release();
    await committing;

    expect(runtime.listPlans()).toEqual([]);
    expect(runtime.queryReceipts()).toEqual([]);
    expect(runtime.getSnapshot().audit).toEqual([]);
  });

  it("drops a rollback that resolves after reset", async () => {
    const held = gate();
    const store = { value: 0 };
    const runtime = runtimeWith([
      defineCapability({
        name: "set_value",
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
    await runtime.invoke("set_value", {});
    const id = runtime.queryReceipts()[0]!.id;

    const undoing = runtime.rollback(id);
    await held.reached;
    await runtime.reset();
    held.release();
    const undone = await undoing;

    expect(undone.ok).toBe(false);
    expect(runtime.queryReceipts()).toEqual([]);
    expect(runtime.getSnapshot().audit).toEqual([]);
  });
});

describe("an approval names the human who authorized it", () => {
  const refund = () =>
    defineCapability({
      name: "refund",
      description: "Refunds an order",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      execute: () => "refunded",
    });

  it("refuses an approval that names no human", async () => {
    const runtime = runtimeWith([refund()]);
    await runtime.start();
    await runtime.invoke("refund", {});
    const pending = runtime.getSnapshot().pending[0]!;

    const approved = await runtime.approve(pending.id);

    expect(approved.isError).toBe(true);
  });

  it("records the approver without disturbing execution identity", async () => {
    const runtime = runtimeWith([refund()]);
    await runtime.start();
    await runtime.invoke("refund", {});
    const pending = runtime.getSnapshot().pending[0]!;

    await runtime.approve(pending.id, { id: "human-7", name: "Amein", kind: "human" });

    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "approval_approved");
    expect((event as { approvedBy?: { id: string } }).approvedBy?.id).toBe("human-7");
    const completed = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed");
    expect((completed as { actor?: { id: string } }).actor?.id).toBe("agent");
  });

  it("refuses an anonymous rejection and records the human who did reject", async () => {
    const runtime = runtimeWith([refund()]);
    await runtime.start();
    await runtime.invoke("refund", {});
    const pending = runtime.getSnapshot().pending[0]!;

    expect((await runtime.reject(pending.id)).isError).toBe(true);
    await runtime.reject(pending.id, { id: "human-7", name: "Amein", kind: "human" });

    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "approval_rejected");
    expect((event as { rejectedBy?: { id: string } }).rejectedBy?.id).toBe("human-7");
  });
});
