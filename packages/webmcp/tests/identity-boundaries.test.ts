import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import type { Actor } from "../src/plan.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import type { PresentationEvent } from "../src/presentation.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT_A = { id: "agent-a", name: "A", kind: "agent" as const };
const AGENT_B = { id: "agent-b", name: "B", kind: "agent" as const };
const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

function writeCapability(name: string, gate?: Promise<void>) {
  return defineCapability({
    name,
    description: `Writes ${name}`,
    risk: "WRITE",
    presentation: { reveal: "anchor" },
    execute: async () => {
      if (gate) {
        await gate;
      }
      return receipt({
        entity: `Entity ${name}`,
        changes: [{ field: "value", before: 0, after: 1 }],
        result: { ok: true },
      });
    },
  });
}

async function start(capabilities: ReturnType<typeof defineCapability>[]) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    actor: AGENT_A,
    capabilities,
  });
  await runtime.start();
  return runtime;
}

describe("the invocation actor is fixed before anything can observe it", () => {
  it("survives a presentation listener that changes the actor synchronously", async () => {
    const runtime = await start([writeCapability("first_write")]);
    const seen: PresentationEvent[] = [];
    runtime.subscribePresentation((event) => {
      seen.push(event);
      if (event.phase === "capability_started") {
        runtime.setActor(AGENT_B);
      }
    });

    await runtime.invoke("first_write", {});

    expect(seen.map((e) => [e.phase, e.actor?.id])).toEqual([
      ["capability_started", "agent-a"],
      ["capability_completed", "agent-a"],
    ]);
    const audited = runtime
      .getSnapshot()
      .audit.filter(
        (e) => e.kind === "execution_started" || e.kind === "execution_completed",
      )
      .map((e) => (e as { actor?: { id: string } }).actor?.id);
    expect(audited).toEqual(["agent-a", "agent-a"]);
    expect(runtime.queryReceipts()[0]?.executedBy?.id).toBe("agent-a");
  });
});

describe("one plan commit has exactly one executor", () => {
  it("does not split a commit across actors when one operation is suspended", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const runtime = await start([
      writeCapability("first_write", gate),
      writeCapability("second_write"),
    ]);
    const plan = await runtime.prepare({
      operations: [{ capability: "first_write" }, { capability: "second_write" }],
    });
    runtime.approvePlan(plan.id, HUMAN);

    const committing = runtime.commitPlan(plan.id);
    runtime.setActor(AGENT_B);
    release();
    await committing;

    const executors = runtime.queryReceipts().map((r) => r.executedBy?.id);
    expect(new Set(executors)).toEqual(new Set(["agent-a"]));
  });
});

describe("a caller-supplied identity is snapshotted before it is trusted", () => {
  function twoFacedHuman(): Actor {
    let reads = 0;
    return {
      id: "operator-1",
      name: "Amein",
      get kind() {
        reads += 1;
        return reads === 1 ? "human" : "agent";
      },
    } as Actor;
  }

  function uncloneableHuman(): Actor {
    return {
      id: "operator-1",
      name: "Amein",
      kind: "human",
      trap: () => {},
    } as unknown as Actor;
  }

  async function planned() {
    const runtime = await start([writeCapability("first_write")]);
    const plan = await runtime.prepare({
      operations: [{ capability: "first_write" }],
    });
    return { runtime, plan };
  }

  it("cannot be approved as a human and then recorded as an agent", async () => {
    const { runtime, plan } = await planned();

    const approved = runtime.approvePlan(plan.id, twoFacedHuman());

    if (approved.ok) {
      expect(runtime.getPlan(plan.id)?.approvedBy?.kind).toBe("human");
      const event = runtime
        .getSnapshot()
        .audit.find((e) => e.kind === "plan_approved");
      expect((event as { actor?: { kind: string } }).actor?.kind).toBe("human");
    } else {
      expect(runtime.getPlan(plan.id)?.status).toBe("DRAFT");
    }
  });

  it("refuses an uncloneable approver instead of throwing and stranding the plan", async () => {
    const { runtime, plan } = await planned();

    const approved = runtime.approvePlan(plan.id, uncloneableHuman());

    expect(approved.ok).toBe(false);
    expect(runtime.getPlan(plan.id)?.status).toBe("DRAFT");
    expect(runtime.getPlan(plan.id)?.approvedBy).toBeUndefined();
    expect(
      runtime.getSnapshot().audit.some((e) => e.kind === "plan_approved"),
    ).toBe(false);
  });

  it("refuses an uncloneable reviewer instead of throwing", async () => {
    const runtime = await start([writeCapability("first_write")]);
    await runtime.invoke("first_write", {});
    const stored = runtime.queryReceipts()[0]!;

    const marked = runtime.markReviewed(stored.id, uncloneableHuman());

    expect(marked.ok).toBe(false);
    expect(runtime.queryReceipts()[0]?.reviewedAt).toBeUndefined();
    expect(
      runtime.getSnapshot().audit.some((e) => e.kind === "receipt_reviewed"),
    ).toBe(false);
  });
});

describe("human-only audit events carry a human without a cast", () => {
  it("types plan_approved and receipt_reviewed as carrying a human actor", async () => {
    const runtime = await start([writeCapability("first_write")]);
    await runtime.invoke("first_write", {});
    const stored = runtime.queryReceipts()[0]!;
    const plan = await runtime.prepare({
      operations: [{ capability: "first_write" }],
    });
    runtime.approvePlan(plan.id, HUMAN);
    runtime.markReviewed(stored.id, HUMAN);

    for (const event of runtime.getSnapshot().audit) {
      if (event.kind === "plan_approved") {
        expect(event.actor.kind).toBe("human");
      }
      if (event.kind === "receipt_reviewed") {
        expect(event.actor.kind).toBe("human");
      }
    }
  });
});
