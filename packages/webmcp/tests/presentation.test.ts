import { describe, expect, it } from "vitest";
import type { PresentationEvent } from "../src/presentation.ts";
import { defineCapability } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function fixture() {
  return [
    defineCapability({
      name: "get_order_shipping",
      description: "Read shipping detail for an order",
      intents: ["order shipping"],
      keywords: ["shipping"],
      presentation: {
        route: (input) => `/orders/${String(input.order_id)}`,
        reveal: "shipping-summary",
        message: (input) => `Inspecting shipping on #${String(input.order_id)}`,
      },
      execute: () => ({ shipping_paid: true }),
    }),
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      presentation: {
        route: (input) => `/orders/${String(input.order_id)}`,
        reveal: "shipping-summary",
        message: "Preparing a shipping refund",
      },
      execute: () => ({ refunded: true }),
    }),
    defineCapability({
      name: "quiet_capability",
      description: "Has no presentation metadata",
      execute: () => "done",
    }),
  ];
}

async function startWithRecorder() {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: fixture(),
  });
  await runtime.start();
  const events: PresentationEvent[] = [];
  runtime.subscribePresentation((event) => events.push(event));
  return { model, runtime, events };
}

describe("presentation trace", () => {
  it("resolves route, reveal, and message from the capability input", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("get_order_shipping", { order_id: "10428" });
    expect(events.map((e) => e.phase)).toEqual([
      "capability_started",
      "capability_completed",
    ]);
    expect(events[0]).toMatchObject({
      capability: "get_order_shipping",
      risk: "READ",
      route: "/orders/10428",
      reveal: "shipping-summary",
      message: "Inspecting shipping on #10428",
    });
  });

  it("emits approval_requested before any handler runs", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    expect(events.map((e) => e.phase)).toEqual([
      "capability_started",
      "approval_requested",
    ]);

    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, { id: "operator", name: "Operator", kind: "human" });
    expect(events.at(-1)).toMatchObject({
      phase: "capability_completed",
      capability: "refund_shipping",
      route: "/orders/10428",
    });
  });

  it("emits an intent_routed event when a task is routed", async () => {
    const { model, events } = await startWithRecorder();
    await model.execute("find_capabilities", { query: "order shipping" });
    const routed = events.find((e) => e.phase === "intent_routed");
    expect(routed?.message).toContain("order shipping");
  });

  it("capabilities without presentation metadata emit bare events", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("quiet_capability", {});
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.route).toBeUndefined();
      expect(event.reveal).toBeUndefined();
      expect(event.message).toBeUndefined();
    }
  });

  it("a throwing presentation listener cannot break execution", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: fixture(),
    });
    await runtime.start();
    runtime.subscribePresentation(() => {
      throw new Error("presentation listener exploded");
    });
    const result = await runtime.invoke("get_order_shipping", {
      order_id: "10428",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ shipping_paid: true });
  });

  it("unsubscribing stops delivery without affecting the runtime", async () => {
    const { runtime, events } = await startWithRecorder();
    const extra: PresentationEvent[] = [];
    const unsubscribe = runtime.subscribePresentation((e) => extra.push(e));
    unsubscribe();
    await runtime.invoke("get_order_shipping", { order_id: "10428" });
    expect(extra).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
  });
});
