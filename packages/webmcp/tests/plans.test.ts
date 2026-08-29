import { describe, expect, it } from "vitest";
import { defineCapability, type Change } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Ledger = {
  refunded: boolean;
  noted: boolean;
  revision: number;
  log: string[];
};

function fixture(ledger: Ledger) {
  return [
    defineCapability({
      name: "refund_shipping",
      description: "Refunds the shipping fee",
      risk: "CONSEQUENTIAL",
      previewChanges: () => [
        { field: "shipping_refunded", before: false, after: true },
      ],
      verify: (_input, _ctx, changes) =>
        ledger.refunded === changes[0]?.after
          ? { status: "VERIFIED" }
          : {
              status: "MISMATCH",
              field: "shipping_refunded",
              expected: changes[0]?.after,
              observed: ledger.refunded,
            },
      rollback: () => {
        ledger.refunded = false;
        ledger.revision += 1;
        return { restored: true };
      },
      execute: () => {
        ledger.refunded = true;
        ledger.revision += 1;
        ledger.log.push("refund");
        return receipt({
          entity: "Order #10428",
          changes: [{ field: "shipping_refunded", before: false, after: true }],
          result: { amount: 18 },
        });
      },
    }),
    defineCapability({
      name: "add_order_note",
      description: "Adds a note",
      risk: "WRITE",
      execute: () => {
        ledger.noted = true;
        ledger.revision += 1;
        ledger.log.push("note");
        return receipt({
          entity: "Order #10428",
          changes: [{ field: "notes", before: 0, after: 1 }],
          result: { ok: true },
        });
      },
    }),
  ];
}

async function start(ledger: Ledger) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: fixture(ledger),
    revision: () => `rev-${ledger.revision}`,
    actor: { id: "agent-1", name: "Ops Agent", kind: "agent" },
  });
  await runtime.start();
  return runtime;
}

const freshLedger = (): Ledger => ({
  refunded: false,
  noted: false,
  revision: 1,
  log: [],
});

describe("versioned operation plans", () => {
  it("prepares a multi-operation plan without executing anything", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping", input: { order_id: "10428" } },
        { capability: "add_order_note", input: { note: "refunded" } },
      ],
    });

    expect(plan.status).toBe("DRAFT");
    expect(plan.operations).toHaveLength(2);
    expect(plan.risk).toBe("CONSEQUENTIAL");
    expect(plan.expectedRevision).toBe("rev-1");
    expect(plan.actor?.id).toBe("agent-1");
    expect(ledger.log).toEqual([]);
  });

  it("refuses to commit a plan that was never approved", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [{ capability: "refund_shipping" }],
    });

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(false);
    expect(ledger.log).toEqual([]);
  });

  it("commits an approved plan and verifies each operation", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping" },
        { capability: "add_order_note" },
      ],
    });
    expect(runtime.approvePlan(plan.id).ok).toBe(true);

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(true);
    expect(ledger.log).toEqual(["refund", "note"]);

    const settled = runtime.getPlan(plan.id)!;
    expect(settled.status).toBe("COMMITTED");
    expect(settled.outcomes?.map((o) => o.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(settled.outcomes?.[0]?.verification.status).toBe("VERIFIED");
    expect(settled.outcomes?.[1]?.verification.status).toBe("UNSUPPORTED");
  });

  it("refuses to commit when the application changed after review", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [{ capability: "refund_shipping" }],
    });
    runtime.approvePlan(plan.id);

    ledger.revision += 1;

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(false);
    expect(ledger.log).toEqual([]);
    expect(runtime.getPlan(plan.id)?.status).toBe("DRIFTED");
    expect(
      runtime.getSnapshot().audit.some((e) => e.kind === "plan_drifted"),
    ).toBe(true);
  });

  it("commits exactly once under a double commit", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [{ capability: "refund_shipping" }],
    });
    runtime.approvePlan(plan.id);

    const [a, b] = await Promise.all([
      runtime.commitPlan(plan.id),
      runtime.commitPlan(plan.id),
    ]);
    expect(ledger.log).toEqual(["refund"]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("rejecting a plan executes nothing", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [{ capability: "refund_shipping" }],
    });

    expect(runtime.rejectPlan(plan.id).ok).toBe(true);
    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(false);
    expect(ledger.log).toEqual([]);
    expect(runtime.getPlan(plan.id)?.status).toBe("REJECTED");
  });

  it("skips an operation whose availability changed, without failing the rest", async () => {
    const ledger = freshLedger();
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      revision: () => "stable",
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Refunds",
          risk: "CONSEQUENTIAL",
          previewChanges: () => [],
          availability: () =>
            ledger.refunded
              ? {
                  available: false,
                  reasonCode: "ALREADY_REFUNDED",
                  reason: "Already refunded.",
                }
              : { available: true },
          execute: () => {
            ledger.refunded = true;
            ledger.log.push("refund");
            return "refunded";
          },
        }),
        defineCapability({
          name: "add_order_note",
          description: "Adds a note",
          risk: "WRITE",
          execute: () => {
            ledger.log.push("note");
            return "noted";
          },
        }),
      ],
    });
    await runtime.start();

    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping" },
        { capability: "add_order_note" },
      ],
    });
    runtime.approvePlan(plan.id);
    ledger.refunded = true;

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(true);
    expect(ledger.log).toEqual(["note"]);
    const outcomes = runtime.getPlan(plan.id)?.outcomes ?? [];
    expect(outcomes[0]?.status).toBe("SKIPPED");
    expect(outcomes[0]?.detail).toContain("ALREADY_REFUNDED");
    expect(outcomes[1]?.status).toBe("COMPLETED");
  });
});

describe("verification reads state back", () => {
  it("reports MISMATCH when the handler lies about what it did", async () => {
    const ledger = freshLedger();
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Claims to refund",
          risk: "WRITE",
          verify: () => ({
            status: "MISMATCH",
            field: "shipping_refunded",
            expected: true,
            observed: false,
          }),
          execute: () =>
            receipt({
              entity: "Order #10428",
              changes: [
                { field: "shipping_refunded", before: false, after: true },
              ],
              result: { ok: true },
            }),
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", {});

    const stored = runtime.queryReceipts({ capability: "refund_shipping" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.verification.status).toBe("MISMATCH");
  });

  it("a throwing verifier does not fail the completed write", async () => {
    const ledger = freshLedger();
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "add_order_note",
          description: "Adds a note",
          risk: "WRITE",
          verify: () => {
            throw new Error("state store unreachable");
          },
          execute: () => {
            ledger.noted = true;
            return receipt({
              entity: "Order #10428",
              changes: [{ field: "notes", before: 0, after: 1 }],
              result: { ok: true },
            });
          },
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("add_order_note", {});

    expect(result.isError).toBeUndefined();
    expect(ledger.noted).toBe(true);
    expect(runtime.queryReceipts()[0]?.verification.status).toBe("PARTIAL");
  });
});

describe("receipt history and provenance", () => {
  it("records actor and plan on every receipt and filters by them", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping" },
        { capability: "add_order_note" },
      ],
    });
    runtime.approvePlan(plan.id);
    await runtime.commitPlan(plan.id);

    const all = runtime.queryReceipts();
    expect(all).toHaveLength(2);
    for (const entry of all) {
      expect(entry.actor?.id).toBe("agent-1");
      expect(entry.planId).toBe(plan.id);
    }
    expect(runtime.queryReceipts({ capability: "refund_shipping" })).toHaveLength(1);
    expect(runtime.queryReceipts({ actorId: "nobody" })).toHaveLength(0);
    expect(runtime.queryReceipts({ limit: 1 })).toHaveLength(1);
  });

  it("a changed actor is reflected on later receipts", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    runtime.setActor({ id: "human-7", name: "Amein", kind: "human" });
    await runtime.invoke("add_order_note", {});

    expect(runtime.queryReceipts()[0]?.actor).toMatchObject({
      id: "human-7",
      kind: "human",
    });
  });
});

describe("receipt history is immutable", () => {
  it("freezes the nested receipt and input, not just the entry", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    await runtime.invoke("add_order_note", { note: "original" });
    const stored = runtime.queryReceipts()[0]!;

    expect(() => {
      (stored.input as Record<string, unknown>).note = "tampered";
    }).toThrow();
    expect(() => {
      (stored.receipt.changes as unknown as Change[]).push({
        field: "injected",
        before: 0,
        after: 1,
      });
    }).toThrow();
    expect(runtime.queryReceipts()[0]?.input.note).toBe("original");
  });
});

describe("rollback is optional and honest about it", () => {
  it("undoes a capability that supports it", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    await runtime.invoke("refund_shipping", {});
    const id = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(id);
    expect(ledger.refunded).toBe(true);

    const stored = runtime.queryReceipts({ capability: "refund_shipping" })[0]!;
    const undone = await runtime.rollback(stored.id);
    expect(undone.ok).toBe(true);
    expect(ledger.refunded).toBe(false);
    expect(runtime.queryReceipts()[0]?.rolledBackAt).toBeDefined();
  });

  it("hands the rollback the input the capability originally ran with", async () => {
    const ledger = freshLedger();
    const seen: Record<string, unknown>[] = [];
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Refunds",
          risk: "WRITE",
          rollback: (input) => {
            seen.push(input);
            return { restored: true };
          },
          execute: () =>
            receipt({
              entity: "Order #10428",
              changes: [
                { field: "shipping_refunded", before: false, after: true },
              ],
              result: { ok: true },
            }),
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", { order_id: "10428" });

    await runtime.rollback(runtime.queryReceipts()[0]!.id);
    expect(seen).toEqual([{ order_id: "10428" }]);
  });

  it("refuses a second rollback of the same receipt", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    await runtime.invoke("refund_shipping", {});
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);
    const stored = runtime.queryReceipts({ capability: "refund_shipping" })[0]!;

    await runtime.rollback(stored.id);
    const again = await runtime.rollback(stored.id);
    expect(again.ok).toBe(false);
  });

  it("says a capability does not support rollback rather than pretending", async () => {
    const ledger = freshLedger();
    const runtime = await start(ledger);
    await runtime.invoke("add_order_note", {});
    const stored = runtime.queryReceipts({ capability: "add_order_note" })[0]!;

    const undone = await runtime.rollback(stored.id);
    expect(undone.ok).toBe(false);
    if (!undone.ok) {
      expect(undone.reason).toContain("does not support rollback");
    }
  });
});
