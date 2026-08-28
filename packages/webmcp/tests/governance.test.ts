import { describe, expect, it } from "vitest";
import { AVAILABLE, defineCapability, unavailable } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Store = { refunded: boolean; log: string[] };

function refundFixture(store: Store) {
  return defineCapability({
    name: "refund_shipping",
    title: "Refund shipping",
    description: "Refund the shipping fee for an order",
    domain: "shipping",
    intents: ["refund shipping"],
    risk: "CONSEQUENTIAL",
    availability: () =>
      store.refunded
        ? unavailable(
            "ALREADY_REFUNDED",
            "Shipping has already been refunded for this order.",
            "issue_credit",
          )
        : AVAILABLE,
    describeApproval: () => "Refund $18.00 shipping for Order #10428.",
    execute: () => {
      store.refunded = true;
      store.log.push("refund executed");
      return { shipping_refunded: true, amount: 18 };
    },
  });
}

describe("two-phase approval", () => {
  it("returns APPROVAL_REQUIRED immediately without running the handler", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    const result = await model.execute("invoke_capability", {
      name: "refund_shipping",
      input: { order_id: "10428" },
    });
    expect(store.log).toEqual([]);
    expect(result).toMatchObject({
      code: "APPROVAL_REQUIRED",
      data: {
        status: "APPROVAL_REQUIRED",
        capability: "refund_shipping",
        risk: "CONSEQUENTIAL",
        summary: "Refund $18.00 shipping for Order #10428.",
      },
    });
    expect(runtime.getSnapshot().pending).toHaveLength(1);
  });

  it("approve re-checks availability, executes, and records the result", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    await model.execute("invoke_capability", { name: "refund_shipping" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    const approved = await runtime.approve(actionId);
    expect(store.refunded).toBe(true);
    expect(JSON.parse(approved.content[0]!.text)).toEqual({
      shipping_refunded: true,
      amount: 18,
    });

    const status = (await model.execute("get_action_status", {
      approval_id: actionId,
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(status.content[0]!.text)).toEqual({
      approval_id: actionId,
      capability: "refund_shipping",
      status: "APPROVED_EXECUTED",
      result: { shipping_refunded: true, amount: 18 },
    });
  });

  it("approval fails closed when state changed after the request", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    await model.execute("invoke_capability", { name: "refund_shipping" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    store.refunded = true;
    const outcome = await runtime.approve(actionId);
    expect(store.log).toEqual([]);
    expect(outcome).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      data: {
        reasonCode: "ALREADY_REFUNDED",
        suggestedCapability: "issue_credit",
      },
    });
    const status = (await model.execute("get_action_status", {
      approval_id: actionId,
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(status.content[0]!.text)).toMatchObject({
      status: "FAILED_UNAVAILABLE",
      reasonCode: "ALREADY_REFUNDED",
    });
  });

  it("reject causes zero side effects and is observable", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    await model.execute("invoke_capability", { name: "refund_shipping" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    runtime.reject(actionId);
    expect(store.refunded).toBe(false);
    expect(store.log).toEqual([]);
    expect(runtime.getSnapshot().pending).toHaveLength(0);

    const status = (await model.execute("get_action_status", {
      approval_id: actionId,
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(status.content[0]!.text)).toMatchObject({
      status: "REJECTED",
    });
  });
});

describe("availability reasons", () => {
  it("surfaces reason codes and suggested alternatives on invocation", async () => {
    const store: Store = { refunded: true, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    const result = await model.execute("invoke_capability", {
      name: "refund_shipping",
    });
    expect(result).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      isError: true,
      data: {
        status: "CAPABILITY_UNAVAILABLE",
        capability: "refund_shipping",
        reasonCode: "ALREADY_REFUNDED",
        reason: "Shipping has already been refunded for this order.",
        suggestedCapability: "issue_credit",
      },
    });
  });

  it("find_capabilities reports unavailable-but-relevant capabilities with reasons", async () => {
    const store: Store = { refunded: true, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    const listed = (await model.execute("find_capabilities", {
      query: "refund shipping",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(listed.content[0]!.text) as {
      matches: Array<Record<string, unknown>>;
      activated_tools: string[];
    };
    expect(payload.matches[0]).toMatchObject({
      name: "refund_shipping",
      available: false,
      reasonCode: "ALREADY_REFUNDED",
      suggestedCapability: "issue_credit",
    });
    expect(payload.activated_tools).not.toContain("refund_shipping");
    expect(model.tools.has("refund_shipping")).toBe(false);
  });
});

describe("audit trail", () => {
  it("produces a deterministic event sequence for the approval flow", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    await model.execute("find_capabilities", { query: "refund shipping" });
    await model.execute("refund_shipping", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId);

    const kinds = runtime
      .getSnapshot()
      .audit.map((event) => event.kind)
      .filter(
        (kind) => kind !== "tool_registered" && kind !== "tool_retired",
      );
    expect(kinds).toEqual([
      "capability_routed",
      "capability_invoked",
      "approval_requested",
      "approval_approved",
      "execution_started",
      "execution_completed",
    ]);
  });

  it("reset clears audit, pending approvals, and routed tools", async () => {
    const store: Store = { refunded: false, log: [] };
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [refundFixture(store)],
    });
    await runtime.start();
    await model.execute("find_capabilities", { query: "refund shipping" });
    await model.execute("refund_shipping", {});
    expect(runtime.getSnapshot().pending).toHaveLength(1);

    await runtime.reset();
    const snapshot = runtime.getSnapshot();
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.audit).toEqual([]);
    expect(snapshot.routedTools).toEqual([]);
    expect(snapshot.tombstones).toEqual([]);
    expect(snapshot.nativeTools).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);
  });
});

describe("exposure modes", () => {
  const catalog = () => [
    defineCapability({
      name: "get_invoice",
      description: "Read an invoice",
      domain: "billing",
      execute: () => "invoice-42",
    }),
    defineCapability({
      name: "search_notes",
      description: "Search notes",
      domain: "support",
      execute: () => "notes",
    }),
    defineCapability({
      name: "update_price",
      description: "Update a product price",
      domain: "inventory",
      risk: "WRITE",
      execute: () => "updated",
    }),
  ];

  it("flat exposure registers the whole applicable catalog", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog(),
      exposure: "flat",
    });
    await runtime.start();
    expect([...model.tools.keys()].sort()).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "get_invoice",
      "invoke_capability",
      "search_notes",
      "update_price",
    ]);
    expect(runtime.getSnapshot().schemaBytes).toBeGreaterThan(0);
  });

  it("routed exposure registers only bootstrap plus the routed working set", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog(),
    });
    await runtime.start();
    expect(model.tools.has("get_invoice")).toBe(false);

    await model.execute("find_capabilities", { query: "invoice" });
    expect(model.tools.has("get_invoice")).toBe(true);
    expect(model.tools.has("search_notes")).toBe(false);
    expect(model.tools.has("update_price")).toBe(false);
  });

  it("switching exposure reconciles the surface with the same handlers", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog(),
      exposure: "flat",
    });
    await runtime.start();
    const flatResult = await model.execute("get_invoice", {});

    await runtime.setExposure("routed");
    const snapshot = runtime.getSnapshot();
    expect(snapshot.nativeTools).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);
    expect(snapshot.tombstones).toEqual([
      "get_invoice",
      "search_notes",
      "update_price",
    ]);
    const invokeResult = await model.execute("invoke_capability", {
      name: "get_invoice",
      input: {},
    });
    expect(invokeResult).toEqual(flatResult);
  });
});
