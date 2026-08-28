import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { rankCapabilities } from "../src/router.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function slowRefundFixture() {
  let executions = 0;
  const capability = defineCapability({
    name: "refund_shipping",
    description: "Refund the shipping fee",
    risk: "CONSEQUENTIAL",
    approvalEvidence: "summary",
    describeApproval: (input) => `Refund order ${String(input.order_id)}`,
    execute: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      executions += 1;
      return { refunded: true, order: input.order_id, executions };
    },
  });
  return { capability, count: () => executions };
}

describe("approval atomicity", () => {
  it("concurrent approve calls execute the action exactly once", async () => {
    const { capability, count } = slowRefundFixture();
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [capability],
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    const [first, second] = await Promise.all([
      runtime.approve(actionId),
      runtime.approve(actionId),
    ]);
    expect(count()).toBe(1);
    const texts = [first.content[0]!.text, second.content[0]!.text];
    expect(texts.filter((t) => t.includes("\"refunded\":true"))).toHaveLength(1);
    expect(
      texts.filter((t) => t.includes("did not run again")),
    ).toHaveLength(1);
  });

  it("stores the approved input by value, not by reference", async () => {
    const seen: unknown[] = [];
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "issue_credit",
          description: "Issue a credit",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: (input) => {
            seen.push(input.details);
            return "done";
          },
        }),
      ],
    });
    await runtime.start();
    const details = { amount: 10 };
    await runtime.invoke("issue_credit", { details });
    details.amount = 9999;
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId);
    expect(seen).toEqual([{ amount: 10 }]);
  });

  it("an identical pending request is deduplicated instead of duplicated", async () => {
    const { capability } = slowRefundFixture();
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [capability],
    });
    await runtime.start();
    const first = await runtime.invoke("refund_shipping", { order_id: "10428" });
    const second = await runtime.invoke("refund_shipping", { order_id: "10428" });
    expect(runtime.getSnapshot().pending).toHaveLength(1);
    expect(first.data?.approval_id).toBe(second.data?.approval_id);

    const different = await runtime.invoke("refund_shipping", { order_id: "10429" });
    expect(different.data?.approval_id).not.toBe(first.data?.approval_id);
    expect(runtime.getSnapshot().pending).toHaveLength(2);
  });
});

describe("lifecycle and observer safety", () => {
  it("a throwing listener does not turn a committed write into a failure", async () => {
    let committed = 0;
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "add_note",
          description: "Add a note",
          risk: "WRITE",
          execute: () => {
            committed += 1;
            return { noted: true };
          },
        }),
      ],
    });
    await runtime.start();
    runtime.subscribe(() => {
      throw new Error("listener exploded");
    });
    const result = await runtime.invoke("add_note", {});
    expect(committed).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ noted: true });
    const kinds = runtime.getSnapshot().audit.map((event) => event.kind);
    expect(kinds).toContain("execution_completed");
    expect(kinds).not.toContain("execution_failed");
  });

  it("a failed initial registration leaves the runtime restartable", async () => {
    let failFirst = true;
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: async (tool, options) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("browser rejected registration");
        }
        return model.registerTool(tool, options);
      },
    });
    await expect(runtime.start()).rejects.toThrow("browser rejected registration");
    expect(runtime.getSnapshot().started).toBe(false);

    await runtime.start();
    expect(runtime.getSnapshot().started).toBe(true);
    expect(runtime.getSnapshot().nativeTools).toContain("find_capabilities");
  });

  it("invoke is rejected before start", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({ name: "ping", description: "Ping", execute: () => "pong" }),
      ],
    });
    const result = await runtime.invoke("ping");
    expect(result.isError).toBe(true);
  });

  it("audit snapshots are detached from internal history", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({ registerTool: model.registerTool });
    await runtime.start();
    const events = runtime.getSnapshot().audit as unknown[];
    const length = events.length;
    (events as unknown[]).length = 0;
    expect(runtime.getSnapshot().audit.length).toBe(length);
  });
});

describe("result and routing hardening", () => {
  it("a handler returning undefined still yields a string result", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "fire_and_forget",
          description: "Returns nothing",
          execute: () => undefined,
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("fire_and_forget", {});
    expect(typeof result.content[0]!.text).toBe("string");
    expect(result.content[0]!.text).toBe("null");
  });

  it("a '/' route only matches the exact root route", () => {
    const dashboard = defineCapability({
      name: "export_dashboard",
      description: "Dashboard export",
      routes: ["/"],
      execute: () => ({}),
    });
    const onRoot = rankCapabilities(
      [dashboard],
      { route: "/", state: {} },
      "",
    );
    expect(onRoot.map((r) => r.capability.name)).toContain("export_dashboard");
    const onBenchmark = rankCapabilities(
      [dashboard],
      { route: "/benchmark", state: {} },
      "",
    );
    expect(onBenchmark).toEqual([]);
  });

  it("tokenizes accented queries so keywords still match", () => {
    const refund = defineCapability({
      name: "refund_shipping",
      description: "Refund shipping",
      keywords: ["remboursement", "livraison"],
      execute: () => ({}),
    });
    const ranked = rankCapabilities(
      [refund],
      { route: "/", state: {} },
      "Remboursement des frais de livraison pour la commande",
    );
    expect(ranked.map((r) => r.capability.name)).toContain("refund_shipping");
  });

  it("oversized discovery queries are truncated before routing and audit", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({ name: "ping", description: "Ping", execute: () => "pong" }),
      ],
    });
    await runtime.start();
    await model.execute("find_capabilities", { query: "x".repeat(120_000) });
    const routedEvent = runtime
      .getSnapshot()
      .audit.find((event) => event.kind === "capability_routed");
    expect(routedEvent).toBeDefined();
    if (routedEvent?.kind === "capability_routed") {
      expect(routedEvent.query.length).toBeLessThanOrEqual(400);
    }
    expect(runtime.getSnapshot().lastRouting?.query.length).toBeLessThanOrEqual(400);
  });

  it("invoke_capability is not advertised as read-only", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({ registerTool: model.registerTool });
    await runtime.start();
    const tool = model.tools.get("invoke_capability");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
  });

  it("switching flat to routed compacts tombstones instead of keeping 78", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: Array.from({ length: 10 }, (_, i) =>
        defineCapability({
          name: `cap_${i}`,
          description: `Capability ${i}`,
          execute: () => i,
        }),
      ),
      exposure: "flat",
    });
    await runtime.start();
    expect(model.tools.size).toBe(14);
    await runtime.setExposure("routed");
    expect(runtime.getSnapshot().tombstones).toEqual([]);
    expect(model.tools.size).toBe(4);
  });
});
