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

  it("is indeterminate even with a verifier, because it answers a different question", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: false, verify: true });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("keeps the attempt time and the failure so an operator can reconcile it", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);
    const stored = runtime.queryReceipts()[0]!;

    expect(stored.rollbackAttemptedAt).toBeGreaterThan(0);
    expect(stored.rollbackFailure).toContain("serialization");
    expect(runtime.getSnapshot().audit.map((e) => e.kind)).toContain(
      "rollback_indeterminate",
    );
  });
});

describe("reconciling an indeterminate rollback", () => {
  it("spends the receipt when someone confirms the compensation landed", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });
    const id = runtime.queryReceipts()[0]!.id;
    await runtime.rollback(id);

    const settled = runtime.reconcileRollback(id, "compensated", {
      id: "human-1",
      kind: "human",
    });

    expect(settled.ok).toBe(true);
    const stored = runtime.queryReceipts()[0]!;
    expect(stored.rollbackState).toBe("ROLLED_BACK");
    expect(stored.reconciledBy?.id).toBe("human-1");
    expect(runtime.getSnapshot().audit.map((e) => e.kind)).toContain(
      "rollback_reconciled",
    );
  });

  it("makes undo available again when someone confirms nothing landed", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });
    const id = runtime.queryReceipts()[0]!.id;
    await runtime.rollback(id);

    runtime.reconcileRollback(id, "untouched", { id: "human-1", kind: "human" });

    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("READY");
  });

  it("refuses to reconcile a receipt that is not indeterminate", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await ledgerRuntime(store, { commits: true, verify: false });
    const id = runtime.queryReceipts()[0]!.id;

    const settled = runtime.reconcileRollback(id, "compensated", { id: "human-1", kind: "human" });

    expect(settled.ok).toBe(false);
  });
});

describe("a rollback that reports success without undoing anything", () => {
  it("is not recorded as rolled back", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = createAgentDeskRuntime({
      registerTool: createMockModelContext().registerTool,
      capabilities: [
        defineCapability({
          name: "set_value",
          description: "Sets the value to 1",
          risk: "WRITE",
          verify: (_i, _c, changes) =>
            store.value === changes[0]?.after
              ? { status: "VERIFIED" }
              : {
                  status: "MISMATCH",
                  field: "value",
                  expected: changes[0]?.after,
                  observed: store.value,
                },
          rollback: () => ({ restored: true }),
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
      ],
    });
    await runtime.start();
    await runtime.invoke("set_value", {});
    const id = runtime.queryReceipts()[0]!.id;

    const outcome = await runtime.rollback(id);

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
    expect(runtime.getSnapshot().audit.map((e) => e.kind)).not.toContain(
      "rollback_performed",
    );
  });

  it("records that an unverifiable rollback rests on the handler's word", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = createAgentDeskRuntime({
      registerTool: createMockModelContext().registerTool,
      capabilities: [
        defineCapability({
          name: "set_value",
          description: "Sets the value to 1",
          risk: "WRITE",
          rollbackEvidence: "handler",
          rollback: (_i, _c, changes) => {
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
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("set_value", {});

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);
    const stored = runtime.queryReceipts()[0]!;

    expect(outcome.ok).toBe(true);
    expect(stored.rollbackState).toBe("ROLLED_BACK");
    expect(stored.rollbackVerification?.status).toBe("UNSUPPORTED");
    expect(store.value).toBe(0);
  });
});
