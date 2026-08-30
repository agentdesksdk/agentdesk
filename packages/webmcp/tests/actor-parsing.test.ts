import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import type { Actor, HumanActor, OperationPlan } from "../src/plan.ts";
import type { StoredReceipt } from "../src/receipts.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT = { id: "agent-a", name: "A", kind: "agent" as const };

function noteCapability() {
  return defineCapability({
    name: "add_order_note",
    description: "Adds a note",
    risk: "WRITE",
    execute: () =>
      receipt({
        entity: "Order #10428",
        changes: [{ field: "notes", before: 0, after: 1 }],
        result: { ok: true },
      }),
  });
}

async function start() {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    actor: AGENT,
    capabilities: [noteCapability()],
  });
  await runtime.start();
  return runtime;
}

const MALFORMED: Array<[string, unknown]> = [
  ["no id at all", { kind: "human" }],
  ["empty id", { id: "", kind: "human" }],
  ["blank id", { id: "   ", kind: "human" }],
  ["non-string id", { id: 42, kind: "human" }],
  ["null id", { id: null, kind: "human" }],
  ["non-string name", { id: "operator-1", kind: "human", name: 7 }],
  ["null actor", null],
  ["a string", "operator-1"],
];

describe("a human identity is parsed, not just narrowed", () => {
  it("refuses every malformed approver and leaves the plan in DRAFT", async () => {
    for (const [label, supplied] of MALFORMED) {
      const runtime = await start();
      const plan = await runtime.prepare({
        operations: [{ capability: "add_order_note" }],
      });

      const approved = runtime.approvePlan(plan.id, supplied as Actor);

      expect(approved.ok, label).toBe(false);
      expect(runtime.getPlan(plan.id)?.status, label).toBe("DRAFT");
      expect(runtime.getPlan(plan.id)?.approvedBy, label).toBeUndefined();
      expect(
        runtime.getSnapshot().audit.some((e) => e.kind === "plan_approved"),
        label,
      ).toBe(false);
    }
  });

  it("refuses every malformed reviewer and records nothing", async () => {
    for (const [label, supplied] of MALFORMED) {
      const runtime = await start();
      await runtime.invoke("add_order_note", {});
      const stored = runtime.queryReceipts()[0]!;

      const marked = runtime.markReviewed(stored.id, supplied as Actor);

      expect(marked.ok, label).toBe(false);
      expect(runtime.queryReceipts()[0]?.reviewedAt, label).toBeUndefined();
      expect(
        runtime.getSnapshot().audit.some((e) => e.kind === "receipt_reviewed"),
        label,
      ).toBe(false);
    }
  });

  it("still accepts a well formed human", async () => {
    const runtime = await start();
    const plan = await runtime.prepare({
      operations: [{ capability: "add_order_note" }],
    });

    const approved = runtime.approvePlan(plan.id, {
      id: "operator-1",
      name: "Amein",
      kind: "human",
    });

    expect(approved.ok).toBe(true);
    expect(runtime.getPlan(plan.id)?.approvedBy?.id).toBe("operator-1");
  });
});

describe("human-only record fields reject an agent at compile time", () => {
  it("types approvedBy and reviewedBy as human", () => {
    const agent: Actor = AGENT;
    const human: HumanActor = { id: "operator-1", kind: "human" };

    // @ts-expect-error an agent cannot be the approver of a plan
    const badPlan: Pick<OperationPlan, "approvedBy"> = { approvedBy: agent };
    // @ts-expect-error an agent cannot be the reviewer of a receipt
    const badReceipt: Pick<StoredReceipt, "reviewedBy"> = { reviewedBy: agent };

    const goodPlan: Pick<OperationPlan, "approvedBy"> = { approvedBy: human };
    const goodReceipt: Pick<StoredReceipt, "reviewedBy"> = { reviewedBy: human };

    expect(badPlan).toBeDefined();
    expect(badReceipt).toBeDefined();
    expect(goodPlan.approvedBy?.kind).toBe("human");
    expect(goodReceipt.reviewedBy?.kind).toBe("human");
  });
});
