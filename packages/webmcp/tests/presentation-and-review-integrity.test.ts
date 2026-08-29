import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Counter = { commits: number };

async function runtimeWithPresentation(
  counter: Counter,
  presentation: Record<string, unknown>,
) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    actor: { id: "agent", name: "Agent", kind: "agent" },
    capabilities: [
      defineCapability({
        name: "add_order_note",
        description: "Adds a note",
        risk: "WRITE",
        presentation,
        execute: () => {
          counter.commits += 1;
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
  return runtime;
}

describe("presentation cannot corrupt a completed write", () => {
  it("keeps the write successful when an announce callback throws after it commits", async () => {
    const counter: Counter = { commits: 0 };
    const runtime = await runtimeWithPresentation(counter, {
      announce: () => {
        if (counter.commits > 0) {
          throw new Error("post-write formatter exploded");
        }
        return "queued";
      },
    });

    const result = await runtime.invoke("add_order_note", {});

    expect(counter.commits).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(runtime.queryReceipts()).toHaveLength(1);
  });

  it("never records the same execution as both completed and failed", async () => {
    const counter: Counter = { commits: 0 };
    const runtime = await runtimeWithPresentation(counter, {
      message: () => {
        if (counter.commits > 0) {
          throw new Error("post-write formatter exploded");
        }
        return "working";
      },
    });

    await runtime.invoke("add_order_note", {});

    const audit = runtime.getSnapshot().audit;
    const completed = audit.filter((e) => e.kind === "execution_completed");
    const failed = audit.filter((e) => e.kind === "execution_failed");
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });

  it("returns a structured result when a presentation callback throws before the write", async () => {
    const counter: Counter = { commits: 0 };
    const runtime = await runtimeWithPresentation(counter, {
      route: () => {
        throw new Error("router exploded");
      },
    });

    const result = await runtime.invoke("add_order_note", {});

    expect(Array.isArray(result.content)).toBe(true);
    expect(typeof result.content[0]?.text).toBe("string");
  });

  it("still delivers the parts of the event the application resolved successfully", async () => {
    const counter: Counter = { commits: 0 };
    const runtime = await runtimeWithPresentation(counter, {
      reveal: "shipping-summary",
      message: () => {
        throw new Error("narration exploded");
      },
    });
    const seen: Array<Record<string, unknown>> = [];
    runtime.subscribePresentation((event) => {
      seen.push(event as unknown as Record<string, unknown>);
    });

    await runtime.invoke("add_order_note", {});

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => event.reveal === "shipping-summary")).toBe(true);
    expect(seen.every((event) => event.message === undefined)).toBe(true);
  });
});

describe("a human review is not attributed to the agent", () => {
  async function agentRuntime() {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      actor: { id: "agent", name: "Agent", kind: "agent" },
      capabilities: [
        defineCapability({
          name: "add_order_note",
          description: "Adds a note",
          risk: "WRITE",
          execute: () =>
            receipt({
              entity: "Order #10428",
              changes: [{ field: "notes", before: 0, after: 1 }],
              result: { ok: true },
            }),
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("add_order_note", {});
    return runtime;
  }

  it("refuses a review that would be credited to the acting agent", async () => {
    const runtime = await agentRuntime();
    const stored = runtime.queryReceipts()[0]!;

    const marked = runtime.markReviewed(stored.id);

    expect(marked.ok).toBe(false);
    if (!marked.ok) {
      expect(marked.reason).toMatch(/human/i);
    }
    expect(runtime.queryReceipts()[0]?.reviewedAt).toBeUndefined();
  });

  it("accepts a review carrying an explicit human identity", async () => {
    const runtime = await agentRuntime();
    const stored = runtime.queryReceipts()[0]!;

    const marked = runtime.markReviewed(stored.id, {
      id: "operator-1",
      name: "Amein",
      kind: "human",
    });

    expect(marked.ok).toBe(true);
    const after = runtime.queryReceipts()[0]!;
    expect(after.reviewedBy?.kind).toBe("human");
    expect(after.reviewedBy?.id).toBe("operator-1");
    // The write itself stays attributed to the agent that performed it.
    expect(after.executedBy?.id).toBe("agent");
  });
});
