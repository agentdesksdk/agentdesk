import { describe, expect, it } from "vitest";
import { AVAILABLE, defineCapability, unavailable } from "../src/capability.ts";
import { rankCapabilities } from "../src/router.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function fixtureCatalog() {
  return [
    defineCapability({
      name: "search_customer",
      description: "Search customers by name or email",
      domain: "customers",
      intents: ["find", "search", "look up"],
      keywords: ["lookup", "name", "email"],
      routes: ["/customers"],
      execute: () => ({ customers: [] }),
    }),
    defineCapability({
      name: "find_customer_orders",
      description: "List orders for a customer",
      domain: "orders",
      intents: ["customer orders"],
      keywords: ["find"],
      entities: ["customerId"],
      execute: () => ({ orders: [] }),
    }),
    defineCapability({
      name: "inspect_order",
      description: "Inspect an order in detail",
      domain: "orders",
      intents: ["inspect order", "order details"],
      entities: ["orderId"],
      routes: ["/orders/"],
      execute: () => ({ order: {} }),
    }),
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      domain: "shipping",
      intents: ["refund shipping"],
      entities: ["orderId"],
      risk: "CONSEQUENTIAL",
      availability: (ctx) =>
        ctx.state.shippingRefunded === true
          ? unavailable(
              "ALREADY_REFUNDED",
              "Shipping has already been refunded for this order.",
              "issue_credit",
            )
          : AVAILABLE,
      describeApproval: (input) =>
        `Refund shipping for order ${String(input.order_id ?? "?")}`,
      execute: () => ({ shipping_refunded: true }),
    }),
    defineCapability({
      name: "get_inventory",
      description: "Read inventory levels for a product",
      domain: "inventory",
      intents: ["stock level"],
      routes: ["/inventory"],
      execute: () => ({ stock: 3 }),
    }),
  ];
}

describe("capability routing", () => {
  it("scores by intent, domain, entity, keyword, and route", () => {
    const ranked = rankCapabilities(
      fixtureCatalog(),
      { route: "/orders/10428", state: { orderId: "10428" } },
      "refund the shipping fee for this order",
    );
    expect(ranked[0]?.capability.name).toBe("refund_shipping");
    expect(ranked.map((r) => r.capability.name)).not.toContain("get_inventory");
  });

  it("uses page context, not just words", () => {
    const onInventory = rankCapabilities(
      fixtureCatalog(),
      { route: "/inventory", state: { domain: "inventory" } },
      "",
    );
    expect(onInventory.map((r) => r.capability.name)).toContain(
      "get_inventory",
    );
    expect(onInventory.map((r) => r.capability.name)).not.toContain(
      "refund_shipping",
    );

    const onOrder = rankCapabilities(
      fixtureCatalog(),
      { route: "/orders/10428", state: { orderId: "10428", domain: "orders" } },
      "",
    );
    expect(onOrder.map((r) => r.capability.name)).toContain("inspect_order");
    expect(onOrder.map((r) => r.capability.name)).toContain("refund_shipping");
  });

  it("never returns more than 6 capabilities", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      defineCapability({
        name: `report_${i}`,
        description: "A report",
        keywords: ["report"],
        execute: () => ({}),
      }),
    );
    const ranked = rankCapabilities(
      many,
      { route: "/", state: {} },
      "report",
      99,
    );
    expect(ranked.length).toBeLessThanOrEqual(6);
  });
});

describe("native dynamic routing", () => {
  async function startFixture() {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: fixtureCatalog(),
    });
    await runtime.start();
    return { model, runtime };
  }

  it("find_capabilities activates relevant tools and leaves unrelated ones unregistered", async () => {
    const { model, runtime } = await startFixture();
    await runtime.setContext({
      route: "/orders/10428",
      state: { orderId: "10428" },
    });
    await model.execute("find_capabilities", {
      query: "refund the shipping fee",
    });
    expect(model.tools.has("refund_shipping")).toBe(true);
    expect(model.tools.has("get_inventory")).toBe(false);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.routedTools).toContain("refund_shipping");
    expect(snapshot.lastRouting?.activated).toContain("refund_shipping");
  });

  it("changing application context reconciles the active set and aborts retired tools", async () => {
    const { model, runtime } = await startFixture();
    await runtime.setContext({
      route: "/orders/10428",
      state: { orderId: "10428" },
    });
    await model.execute("find_capabilities", { query: "refund shipping" });
    expect(model.tools.has("refund_shipping")).toBe(true);

    await runtime.setContext({
      route: "/orders/10428",
      state: { orderId: "10428", shippingRefunded: true },
    });
    expect(runtime.getSnapshot().routedTools).not.toContain("refund_shipping");
    expect(model.aborted).toContain("refund_shipping");

    const stale = await model.execute("refund_shipping", {});
    expect(stale).toMatchObject({
      code: "TOOL_RETIRED",
      data: {
        status: "TOOL_RETIRED",
        capability: "refund_shipping",
        next: "Call find_capabilities with the current task.",
      },
    });
  });

  it("invoke_capability resolves the same handler as the native tool", async () => {
    const { model, runtime } = await startFixture();
    await runtime.setContext({
      route: "/orders/10428",
      state: { orderId: "10428" },
    });
    await model.execute("find_capabilities", { query: "inspect order" });
    const nativeResult = await model.execute("inspect_order", {});
    const invokeResult = await model.execute("invoke_capability", {
      name: "inspect_order",
      input: {},
    });
    expect(invokeResult).toEqual(nativeResult);
    const kinds = runtime
      .getSnapshot()
      .audit.filter((event) => event.kind === "capability_invoked")
      .map((event) => (event.kind === "capability_invoked" ? event.via : ""));
    expect(kinds).toEqual(["native", "invoke"]);
  });
});
