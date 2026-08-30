import { describe, expect, it } from "vitest";
import { defineCapability, type CapabilitySpec } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const HUMAN = { id: "human-1", name: "Ada", kind: "human" } as const;

type Store = { value: number; compensations: number };

/** Holds the compensating action open so a stop or reset lands mid-flight. */
function suspended() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function runtimeWithHeldRollback(
  store: Store,
  gate: Promise<void>,
  extra: Partial<CapabilitySpec> = {},
) {
  const runtime = createAgentDeskRuntime({
    registerTool: createMockModelContext().registerTool,
    capabilities: [
      defineCapability({
        name: "set_value",
        description: "Sets the value to 1",
        risk: "WRITE",
        rollbackEvidence: "handler",
        rollback: async (_i, _c, changes) => {
          await gate;
          store.compensations += 1;
          store.value = changes[0]?.before as number;
          return "restored";
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
        ...extra,
      } as CapabilitySpec),
    ],
  });
  await runtime.start();
  await runtime.invoke("set_value", {});
  return runtime;
}

describe("a rollback interrupted by stop", () => {
  it("agrees across receipt, audit, and returned result", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.stop();
    release();
    const outcome = await undo;

    const stored = runtime.queryReceipts()[0]!;
    const kinds = runtime.getSnapshot().audit.map((e) => e.kind);

    expect(outcome.ok).toBe(false);
    expect(stored.rollbackState).toBe("INDETERMINATE");
    expect(kinds).not.toContain("rollback_performed");
    expect(stored.rollbackFailure).toMatch(/session/i);
  });

  it("does not strand the receipt as still rolling back", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.stop();
    release();
    await undo;

    expect(runtime.queryReceipts()[0]!.rollbackState).not.toBe("ROLLING_BACK");
  });

  it("stays reconcilable, because the compensating action did run", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.stop();
    release();
    await undo;

    expect(store.compensations).toBe(1);
    const settled = runtime.reconcileRollback(id, "compensated", HUMAN);
    expect(settled.ok).toBe(true);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("ROLLED_BACK");
  });

  it("refuses a second undo rather than compensating twice", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.stop();
    release();
    await undo;
    await runtime.start();
    const again = await runtime.rollback(id);

    expect(store.compensations).toBe(1);
    expect(again.ok).toBe(false);
  });
});

describe("a rollback interrupted by reset", () => {
  it("leaves nothing claiming an outcome the audit does not carry", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.reset();
    release();
    const outcome = await undo;

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()).toEqual([]);
    expect(
      runtime.getSnapshot().audit.map((e) => e.kind),
    ).not.toContain("rollback_performed");
  });

  it("cannot be reconciled after the receipt it named is gone", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const { gate, release } = suspended();
    const runtime = await runtimeWithHeldRollback(store, gate);
    const id = runtime.queryReceipts()[0]!.id;

    const undo = runtime.rollback(id);
    await runtime.reset();
    release();
    await undo;

    const settled = runtime.reconcileRollback(id, "compensated", HUMAN);
    expect(settled.ok).toBe(false);
  });
});
