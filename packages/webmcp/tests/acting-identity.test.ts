import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import type { PresentationEvent } from "../src/presentation.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT = { id: "agent-a", name: "A", kind: "agent" as const };
const OTHER_AGENT = { id: "agent-b", name: "B", kind: "agent" as const };
const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

function deferred() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

async function start(capabilities: ReturnType<typeof defineCapability>[]) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    actor: AGENT,
    capabilities,
  });
  await runtime.start();
  return runtime;
}

function noteCapability(gate?: Promise<void>) {
  return defineCapability({
    name: "add_order_note",
    description: "Adds a note",
    risk: "WRITE",
    presentation: { reveal: "order-notes" },
    execute: async () => {
      if (gate) {
        await gate;
      }
      return receipt({
        entity: "Order #10428",
        changes: [{ field: "notes", before: 0, after: 1 }],
        result: { ok: true },
      });
    },
  });
}

describe("execution provenance is captured when the execution starts", () => {
  it("attributes one execution to one actor even if the actor changes mid-flight", async () => {
    const { gate, release } = deferred();
    const runtime = await start([noteCapability(gate)]);
    const seen: PresentationEvent[] = [];
    runtime.subscribePresentation((event) => seen.push(event));

    const inFlight = runtime.invoke("add_order_note", {});
    runtime.setActor(OTHER_AGENT);
    release();
    await inFlight;

    const audit = runtime.getSnapshot().audit;
    const actors = audit
      .filter(
        (e) => e.kind === "execution_started" || e.kind === "execution_completed",
      )
      .map((e) => (e as { actor?: { id: string } }).actor?.id);

    expect(actors).toEqual(["agent-a", "agent-a"]);
    expect(runtime.queryReceipts()[0]?.executedBy?.id).toBe("agent-a");
    expect(
      seen
        .filter((e) => e.phase === "capability_completed")
        .every((e) => e.actor?.id === "agent-a"),
    ).toBe(true);
  });

  it("uses the new actor for the next execution", async () => {
    const runtime = await start([noteCapability()]);
    await runtime.invoke("add_order_note", {});
    runtime.setActor(OTHER_AGENT);
    await runtime.invoke("add_order_note", {});

    const executed = runtime.queryReceipts().map((r) => r.executedBy?.id);
    expect(executed).toContain("agent-a");
    expect(executed).toContain("agent-b");
  });
});

describe("a plan approval names a human authorizer", () => {
  async function planRuntime() {
    const runtime = await start([noteCapability()]);
    const plan = await runtime.prepare({
      operations: [{ capability: "add_order_note" }],
    });
    return { runtime, plan };
  }

  it("refuses an approval that would be credited to the requesting agent", async () => {
    const { runtime, plan } = await planRuntime();

    const approved = runtime.approvePlan(plan.id);

    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.reason).toMatch(/human/i);
    }
    expect(runtime.getPlan(plan.id)?.status).toBe("DRAFT");
  });

  it("keeps requester, approver, and executor independent", async () => {
    const { runtime, plan } = await planRuntime();

    expect(runtime.approvePlan(plan.id, HUMAN).ok).toBe(true);
    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(true);

    const settled = runtime.getPlan(plan.id)!;
    expect(settled.requestedBy?.id).toBe("agent-a");
    expect(settled.approvedBy?.id).toBe("operator-1");
    expect(settled.approvedBy?.kind).toBe("human");
    expect(runtime.queryReceipts()[0]?.executedBy?.id).toBe("agent-a");
  });

  it("records the approver on the plan_approved audit event", async () => {
    const { runtime, plan } = await planRuntime();
    runtime.approvePlan(plan.id, HUMAN);

    const approved = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "plan_approved");
    expect(approved?.actor.id).toBe("operator-1");
  });

  it("does not require mutating the ambient actor to approve", async () => {
    const { runtime, plan } = await planRuntime();
    runtime.approvePlan(plan.id, HUMAN);
    await runtime.commitPlan(plan.id);

    expect(runtime.getSnapshot().actor?.id).toBe("agent-a");
  });
});

describe("an exported audit stream can answer who reviewed", () => {
  it("records the human reviewer on the receipt_reviewed event", async () => {
    const runtime = await start([noteCapability()]);
    await runtime.invoke("add_order_note", {});
    const stored = runtime.queryReceipts()[0]!;

    expect(runtime.markReviewed(stored.id, HUMAN).ok).toBe(true);

    const reviewed = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "receipt_reviewed");
    expect(reviewed?.actor.id).toBe("operator-1");
    expect(reviewed?.actor.kind).toBe("human");
  });
});
