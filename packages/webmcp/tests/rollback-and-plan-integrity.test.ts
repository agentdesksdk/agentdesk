import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Store = { value: number; rollbackCalls: number };

function ledgerCapability(store: Store) {
  return defineCapability({
    name: "set_value",
    description: "Sets the value to 1",
    risk: "WRITE",
    verify: (_input, _ctx, changes) =>
      store.value === changes[0]?.after
        ? { status: "VERIFIED" }
        : {
            status: "MISMATCH",
            field: "value",
            expected: changes[0]?.after,
            observed: store.value,
          },
    rollback: async (_input, _ctx, changes) => {
      store.rollbackCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.value = changes[0]?.before as number;
      return { restored: store.value };
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
  });
}

async function ledgerRuntime(store: Store) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: [ledgerCapability(store)],
    actor: { id: "actor-a", name: "A", kind: "agent" },
  });
  await runtime.start();
  return runtime;
}

describe("rollback safety", () => {
  it("runs the rollback handler exactly once under concurrent calls", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    await runtime.invoke("set_value", {});
    const stored = runtime.queryReceipts()[0]!;

    const [a, b] = await Promise.all([
      runtime.rollback(stored.id),
      runtime.rollback(stored.id),
    ]);

    expect(store.rollbackCalls).toBe(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("refuses to undo when the value moved on after the receipt", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    await runtime.invoke("set_value", {});
    const stored = runtime.queryReceipts()[0]!;

    store.value = 2;

    const undone = await runtime.rollback(stored.id);

    expect(undone.ok).toBe(false);
    if (!undone.ok) {
      expect(undone.reason).toMatch(/conflict|changed|no longer/i);
    }
    expect(store.value).toBe(2);
    expect(store.rollbackCalls).toBe(0);
  });
});

describe("a committed plan means the work actually happened", () => {
  it("does not report success when every operation was skipped", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "set_value",
          description: "Sets the value",
          risk: "WRITE",
          availability: () =>
            store.value > 0
              ? { available: false, reasonCode: "ALREADY_SET", reason: "Already set." }
              : { available: true },
          execute: () => {
            store.value = 1;
            return "set";
          },
        }),
      ],
    });
    await runtime.start();

    const plan = await runtime.prepare({ operations: [{ capability: "set_value" }] });
    runtime.approvePlan(plan.id);
    store.value = 5;

    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(false);
    expect(runtime.getPlan(plan.id)?.status).not.toBe("COMMITTED");
  });

  it("does not report success when verification disproved the result", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "set_value",
          description: "Claims to set the value",
          risk: "WRITE",
          verify: () => ({
            status: "MISMATCH",
            field: "value",
            expected: 1,
            observed: 0,
          }),
          execute: () =>
            receipt({
              entity: "Ledger",
              changes: [{ field: "value", before: 0, after: 1 }],
              result: { value: 1 },
            }),
        }),
      ],
    });
    await runtime.start();

    const plan = await runtime.prepare({ operations: [{ capability: "set_value" }] });
    runtime.approvePlan(plan.id);

    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(false);
    expect(runtime.getPlan(plan.id)?.status).not.toBe("COMMITTED");
  });

  it("gives every completed operation its execution id", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    const plan = await runtime.prepare({ operations: [{ capability: "set_value" }] });
    runtime.approvePlan(plan.id);
    await runtime.commitPlan(plan.id);

    const outcome = runtime.getPlan(plan.id)?.outcomes?.[0];
    expect(outcome?.status).toBe("COMPLETED");
    expect(outcome?.executionId).toMatch(/^EXE-/);
    expect(runtime.queryReceipts()[0]?.executionId).toBe(outcome?.executionId);
  });
});

describe("provenance survives a change of actor", () => {
  it("attributes the write to the actor the plan was approved for", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);

    const plan = await runtime.prepare({ operations: [{ capability: "set_value" }] });
    runtime.approvePlan(plan.id);
    runtime.setActor({ id: "actor-b", name: "B", kind: "agent" });
    await runtime.commitPlan(plan.id);

    const stored = runtime.queryReceipts()[0]!;
    expect(plan.requestedBy?.id).toBe("actor-a");
    expect(stored.executedBy?.id).toBe("actor-b");
    // The receipt must still say which plan authorized it, so a reader can
    // tell requester from executor rather than seeing one blended actor.
    expect(stored.planId).toBe(plan.id);
  });

  it("records the acting actor on the execution audit event", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    await runtime.invoke("set_value", {});

    const completed = runtime
      .getSnapshot()
      .audit.find((event) => event.kind === "execution_completed");
    expect(completed).toBeDefined();
    expect((completed as { actor?: { id: string } }).actor?.id).toBe("actor-a");
  });

  it("does not let a caller mutate the actor it handed to setActor", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    const mutable = { id: "actor-c", name: "C", kind: "agent" as const };
    runtime.setActor(mutable);
    mutable.id = "tampered";

    await runtime.invoke("set_value", {});
    expect(runtime.queryReceipts()[0]?.executedBy?.id).toBe("actor-c");
  });
});

describe("reset clears everything the runtime accumulated", () => {
  it("drops plans and receipts", async () => {
    const store: Store = { value: 0, rollbackCalls: 0 };
    const runtime = await ledgerRuntime(store);
    await runtime.prepare({ operations: [{ capability: "set_value" }] });
    await runtime.invoke("set_value", {});

    expect(runtime.listPlans()).toHaveLength(1);
    expect(runtime.queryReceipts()).toHaveLength(1);

    await runtime.reset();

    expect(runtime.listPlans()).toEqual([]);
    expect(runtime.queryReceipts()).toEqual([]);
  });
});
