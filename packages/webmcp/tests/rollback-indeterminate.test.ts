import { describe, expect, it } from "vitest";
import { defineCapability, type CapabilitySpec } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Store = { value: number; compensations: number };

type Shape = {
  /** Whether the compensating write lands before the handler throws. */
  commits: boolean;
  verify: boolean;
};

function throwingRollback(store: Store, shape: Shape) {
  const spec: CapabilitySpec = {
    name: "set_value",
    description: "Sets the value to 1",
    risk: "WRITE",
    rollback: (_input, _ctx, changes) => {
      if (shape.commits) {
        store.compensations += 1;
        store.value = changes[0]?.before as number;
      }
      throw new Error("response serialization failed after commit");
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
  };
  if (shape.verify) {
    spec.verify = (_input, _ctx, changes) =>
      store.value === changes[0]?.after
        ? { status: "VERIFIED" }
        : {
            status: "MISMATCH",
            field: "value",
            expected: changes[0]?.after,
            observed: store.value,
          };
  }
  return defineCapability(spec);
}

async function ledgerRuntime(store: Store, shape: Shape) {
  const runtime = createAgentDeskRuntime({
    registerTool: createMockModelContext().registerTool,
    capabilities: [throwingRollback(store, shape)],
    actor: { id: "actor-a", name: "A", kind: "agent" },
  });
  await runtime.start();
  await runtime.invoke("set_value", {});
  return runtime;
}

describe("a rollback that commits and then throws", () => {
  it("does not run the compensating action twice", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });
    const id = runtime.queryReceipts()[0]!.id;

    const first = await runtime.rollback(id);
    const second = await runtime.rollback(id);

    expect(store.compensations).toBe(1);
    expect(first.ok).toBe(false);
    if (second.ok) {
      throw new Error("the second rollback should have been refused");
    }
    expect(second.reason).toMatch(/indeterminate/i);
    expect(second.reason).toContain(id);
  });

  it("leaves the receipt indeterminate rather than ready to retry", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("stays indeterminate when the verifier shows the compensation landed", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: true });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(store.compensations).toBe(1);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("is indeterminate even when nothing committed, if nothing can prove it", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: false, verify: false });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(store.compensations).toBe(0);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("returns to ready when the verifier proves the compensation never landed", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: false, verify: true });
    const id = runtime.queryReceipts()[0]!.id;

    const first = await runtime.rollback(id);

    expect(first.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("READY");
  });
});
