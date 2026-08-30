import { describe, expect, it } from "vitest";
import { defineCapability, type CapabilitySpec } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Store = { value: number; compensations: number };

function ledger(store: Store, spec: Partial<CapabilitySpec>) {
  return defineCapability({
    name: "set_value",
    description: "Sets the value to 1",
    risk: "WRITE",
    execute: () => {
      store.value = 1;
      return receipt({
        entity: "Ledger",
        changes: [{ field: "value", before: 0, after: 1 }],
        undoable: true,
        result: { value: 1 },
      });
    },
    ...spec,
  } as CapabilitySpec);
}

async function runtimeFor(store: Store, spec: Partial<CapabilitySpec>, actor?: {
  id: string;
  kind: "agent" | "human" | "system";
}) {
  const runtime = createAgentDeskRuntime({
    registerTool: createMockModelContext().registerTool,
    capabilities: [ledger(store, spec)],
    ...(actor ? { actor } : {}),
  });
  await runtime.start();
  await runtime.invoke("set_value", {});
  return runtime;
}

const seesAfterValue = (store: Store) => () =>
  store.value === 1
    ? ({ status: "VERIFIED" } as const)
    : ({ status: "MISMATCH", field: "value", expected: 1, observed: store.value } as const);

describe("a rollback that lands on the wrong state", () => {
  it("is not recorded as rolled back", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      verify: seesAfterValue(store),
      rollback: () => {
        store.value = 2;
        return "changed to the wrong value";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(store.value).toBe(2);
    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
    expect(runtime.getSnapshot().audit.map((e) => e.kind)).not.toContain(
      "rollback_performed",
    );
  });

  it("does not count a failed rollback verification as proof of restoration", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      verifyRollback: () => {
        throw new Error("verification unavailable");
      },
      rollback: () => {
        store.value = 0;
        return "restored";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("records the undo when the capability accepts the handler's word", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      rollbackEvidence: "handler",
      rollback: (_i, _c, changes) => {
        store.value = changes[0]?.before as number;
        return "restored";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);
    const stored = runtime.queryReceipts()[0]!;

    expect(outcome.ok).toBe(true);
    expect(stored.rollbackState).toBe("ROLLED_BACK");
    expect(stored.rollbackVerification?.status).toBe("UNSUPPORTED");
  });

  it("leaves an undo unreconciled when the capability declared no evidence", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      rollback: (_i, _c, changes) => {
        store.value = changes[0]?.before as number;
        return "restored";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("is recorded as rolled back when a rollback verifier proves restoration", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      verify: seesAfterValue(store),
      verifyRollback: (_i, _c, changes) =>
        store.value === changes[0]?.before
          ? { status: "VERIFIED" }
          : {
              status: "MISMATCH",
              field: "value",
              expected: changes[0]?.before,
              observed: store.value,
            },
      rollback: (_i, _c, changes) => {
        store.value = changes[0]?.before as number;
        return "restored";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);
    const stored = runtime.queryReceipts()[0]!;

    expect(outcome.ok).toBe(true);
    expect(stored.rollbackState).toBe("ROLLED_BACK");
    expect(stored.rollbackVerification?.status).toBe("VERIFIED");
  });

  it("refuses when the rollback verifier says the before-state is not back", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      verifyRollback: (_i, _c, changes) =>
        store.value === changes[0]?.before
          ? { status: "VERIFIED" }
          : {
              status: "MISMATCH",
              field: "value",
              expected: changes[0]?.before,
              observed: store.value,
            },
      rollback: () => {
        store.value = 2;
        return "wrong";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });
});

describe("reconciling an indeterminate rollback", () => {
  async function indeterminate(actor?: { id: string; kind: "agent" | "human" }) {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(
      store,
      {
        rollback: () => {
          store.compensations += 1;
          throw new Error("unknown outcome");
        },
      },
      actor,
    );
    const id = runtime.queryReceipts()[0]!.id;
    await runtime.rollback(id);
    return { runtime, id, store };
  }

  it("refuses an outcome it does not recognise", async () => {
    const { runtime, id } = await indeterminate();

    const settled = runtime.reconcileRollback(
      id,
      "not-a-real-outcome" as never,
      { id: "human-1", kind: "human" },
    );

    expect(settled.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("does not let the ambient agent sign off on its own compensation", async () => {
    const { runtime, id } = await indeterminate({ id: "agent-1", kind: "agent" });

    const settled = runtime.reconcileRollback(id, "untouched");

    expect(settled.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });

  it("stores a detached snapshot of the reconciler", async () => {
    const { runtime, id } = await indeterminate();
    let kind = "human";
    const shifty = {
      id: "human-1",
      get kind() {
        return kind as "human" | "agent";
      },
    };

    runtime.reconcileRollback(id, "compensated", shifty as never);
    kind = "agent";

    expect(runtime.queryReceipts()[0]!.reconciledBy?.kind).toBe("human");
    expect(Object.isFrozen(shifty)).toBe(false);
  });

  it("names the reconciler on the audit event", async () => {
    const { runtime, id } = await indeterminate();

    runtime.reconcileRollback(id, "compensated", { id: "human-7", kind: "human" });

    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "rollback_reconciled");
    expect(event && "actor" in event ? event.actor?.id : undefined).toBe("human-7");
  });
});

describe("the source of rollback evidence", () => {
  it("does not accept a verifier that could not verify as the handler opt-out", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      verifyRollback: () => ({ status: "UNSUPPORTED" }),
      rollback: (_i, _c, changes) => {
        store.value = changes[0]?.before as number;
        return "restored";
      },
    });

    const outcome = await runtime.rollback(runtime.queryReceipts()[0]!.id);

    expect(outcome.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
    expect(runtime.getSnapshot().audit.map((e) => e.kind)).not.toContain(
      "rollback_performed",
    );
  });

  it("refuses to define a capability that declares a verifier and waives it", () => {
    expect(() =>
      defineCapability({
        name: "contradictory",
        description: "Declares a rollback verifier and then waives it",
        risk: "WRITE",
        verifyRollback: () => ({ status: "VERIFIED" }),
        rollbackEvidence: "handler",
        rollback: () => undefined,
        execute: () => ({ ok: true }),
      }),
    ).toThrow(/verifyRollback/);
  });
});

describe("reconciling with an actor the platform cannot clone", () => {
  it("refuses through the result contract instead of throwing", async () => {
    const store: Store = { value: 0, compensations: 0 };
    const runtime = await runtimeFor(store, {
      rollback: () => {
        throw new Error("unknown outcome");
      },
    });
    const id = runtime.queryReceipts()[0]!.id;
    await runtime.rollback(id);

    const settled = runtime.reconcileRollback(id, "compensated", {
      id: "human-1",
      kind: "human",
      notify: () => undefined,
    } as never);

    expect(settled.ok).toBe(false);
    expect(runtime.queryReceipts()[0]!.rollbackState).toBe("INDETERMINATE");
  });
});
