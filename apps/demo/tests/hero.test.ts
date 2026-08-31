import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  type NativeToolDefinition,
  type ToolResult,
} from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { stagingAdapter } from "../src/capabilities/staged.ts";
import { getState, resetStore } from "../src/data/store.ts";

function mockModel() {
  const tools = new Map<string, NativeToolDefinition>();
  return {
    tools,
    registerTool: async (
      tool: NativeToolDefinition,
      options?: { signal?: AbortSignal },
    ) => {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => {
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name);
        }
      });
    },
    async execute(name: string, input: object = {}): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`not registered: ${name}`);
      }
      return (await tool.execute(input, {
        signal: new AbortController().signal,
      })) as ToolResult;
    },
  };
}

const HERO_QUERY =
  "Find Alice Johnson's unshipped order. If she paid shipping, refund the shipping fee.";

describe("hero scenario", () => {
  beforeEach(() => {
    resetStore();
  });

  it("seeds Alice Johnson's order #10428 exactly as specified", () => {
    const order = getState().orders.find((o) => o.id === "10428");
    const alice = getState().customers.find((c) => c.name === "Alice Johnson");
    expect(alice).toBeDefined();
    expect(order).toMatchObject({
      customerId: alice!.id,
      status: "processing",
      shippingFee: 18,
      shippingPaid: true,
      shippingRefunded: false,
    });
    const unshipped = getState().orders.filter(
      (o) => o.customerId === alice!.id && o.status === "processing",
    );
    expect(unshipped.map((o) => o.id)).toEqual(["10428"]);
  });

  it("routes the hero intent to a small working set including refund_shipping", async () => {
    const model = mockModel();
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: model.registerTool,
      staging: stagingAdapter,
    });
    await runtime.start();
    expect(model.tools.size).toBe(4);

    const result = await model.execute("find_capabilities", {
      query: HERO_QUERY,
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      catalog_size: number;
      activated_tools: string[];
    };
    expect(payload.catalog_size).toBe(capabilities.length);
    expect(payload.activated_tools.length).toBeLessThanOrEqual(6);
    expect(payload.activated_tools).toContain("refund_shipping");
    expect(payload.activated_tools).toContain("find_unshipped_orders");
    expect(model.tools.size).toBeLessThanOrEqual(4 + 6);
  });

  it("completes the full flow: find, inspect, approval-gated refund, execute", async () => {
    const model = mockModel();
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: model.registerTool,
      staging: stagingAdapter,
    });
    await runtime.start();
    await model.execute("find_capabilities", { query: HERO_QUERY });

    const unshipped = await model.execute("find_unshipped_orders", {
      customer: "Alice Johnson",
    });
    const found = JSON.parse(unshipped.content[0]!.text) as {
      orders: Array<{ order_id: string; shipping_paid: boolean }>;
    };
    expect(found.orders).toHaveLength(1);
    expect(found.orders[0]).toMatchObject({
      order_id: "10428",
      shipping_paid: true,
    });

    const refund = await model.execute("refund_shipping", {
      order_id: "10428",
    });
    expect(refund.code).toBe("APPROVAL_REQUIRED");
    expect(refund.data?.summary).toBe(
      "Refund $18.00 shipping for Order #10428 (Alice Johnson).",
    );
    expect(refund.data?.will_change).toContainEqual({
      field: "Order #10428 shipping refunded",
      before: false,
      after: true,
    });
    expect(getState().orders.find((o) => o.id === "10428")?.shippingRefunded).toBe(
      false,
    );

    const actionId = runtime.getSnapshot().pending[0]!.id;
    const approved = await runtime.approve(actionId, { id: "operator", name: "Operator", kind: "human" });
    const payload = JSON.parse(approved.content[0]!.text) as {
      status: string;
      result: Record<string, unknown>;
      receipt: { entity: string; changes: Array<Record<string, unknown>> };
    };
    expect(payload.status).toBe("COMPLETED");
    expect(payload.result).toEqual({
      order_id: "10428",
      shipping_refunded: true,
      amount: 18,
    });
    expect(payload.receipt.entity).toBe("Order #10428");
    expect(payload.receipt.changes).toContainEqual({
      field: "Order #10428 shipping refunded",
      before: false,
      after: true,
    });
    const order = getState().orders.find((o) => o.id === "10428")!;
    expect(order.shippingRefunded).toBe(true);
    expect(getState().credits).toHaveLength(1);

    const second = await model.execute("refund_shipping", { order_id: "10428" });
    expect(second.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(second.data?.reasonCode).toBe("ALREADY_REFUNDED");
  });

  it("reset restores pristine state after mutations", async () => {
    const model = mockModel();
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: model.registerTool,
      staging: stagingAdapter,
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId, { id: "operator", name: "Operator", kind: "human" });
    expect(getState().orders.find((o) => o.id === "10428")?.shippingRefunded).toBe(
      true,
    );

    resetStore();
    await runtime.reset();
    expect(getState().orders.find((o) => o.id === "10428")?.shippingRefunded).toBe(
      false,
    );
    expect(getState().credits).toHaveLength(0);
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(runtime.getSnapshot().audit).toEqual([]);
  });

  it("baseline (flat) and agentdesk (routed) share one catalog and handlers", async () => {
    const flatModel = mockModel();
    const flat = createAgentDeskRuntime({
      capabilities,
      registerTool: flatModel.registerTool,
      staging: stagingAdapter,
      exposure: "flat",
    });
    await flat.start();
    expect(flatModel.tools.size).toBe(4 + capabilities.length);

    const flatResult = await flatModel.execute("get_order_shipping", {
      order_id: "10428",
    });

    const routedModel = mockModel();
    const routed = createAgentDeskRuntime({
      capabilities,
      registerTool: routedModel.registerTool,
      staging: stagingAdapter,
    });
    await routed.start();
    const viaInvoke = await routedModel.execute("invoke_capability", {
      name: "get_order_shipping",
      input: { order_id: "10428" },
    });
    expect(viaInvoke.content).toEqual(flatResult.content);
  });
});
