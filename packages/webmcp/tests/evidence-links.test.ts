import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type AgentView,
  type Capability,
  type EvidenceLink,
} from "../src/index.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };
const TOKEN = "tok_secret_9f8e";

const CHANGES = [{ field: "shipping_refunded", before: false, after: true }];

/** A refund whose receipt carries whatever evidence the test hands it. */
function refund(options: {
  presentation?: boolean;
  evidence?: EvidenceLink[];
}): Capability {
  return defineCapability({
    name: "refund_shipping",
    description: "Refund the shipping fee for an order",
    risk: "WRITE",
    ...(options.presentation
      ? {
          presentation: {
            route: (input) => `/orders/${String(input.order_id)}`,
            reveal: "shipping-summary",
          },
        }
      : {}),
    execute: (input) =>
      receipt({
        entity: `Order #${String(input.order_id)}`,
        changes: CHANGES,
        ...(options.evidence ? { evidence: options.evidence } : {}),
        result: { refunded: true },
      }),
  });
}

async function booted(capability: Capability, options: { agentView?: AgentView } = {}) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: [capability],
    actor: AGENT,
    ...(options.agentView ? { agentView: options.agentView } : {}),
  });
  await runtime.start();
  await runtime.setContext({
    route: "/orders/10428",
    state: { orderId: "10428", customerId: "CUS-104", paymentToken: TOKEN },
  });
  return runtime;
}

function links(result: { data?: Record<string, unknown> }): unknown[] {
  return (result.data?.evidence as Array<{ kind: string }>).filter((item) => item.kind === "link");
}

describe("evidence deep links: authored", () => {
  const authored: EvidenceLink[] = [
    { label: "Shipping line on the invoice", route: "/orders/10428/invoice", reveal: "invoice-shipping" },
  ];

  it("survives to the stored receipt and to the result", async () => {
    const runtime = await booted(refund({ presentation: true, evidence: authored }));

    const result = await runtime.invoke("refund_shipping", { order_id: "10428" });

    const [stored] = runtime.queryReceipts();
    expect(stored?.receipt.evidence).toEqual(authored);
    expect((result.data?.receipt as { evidence?: unknown }).evidence).toEqual(authored);
    expect(links(result)).toEqual([{ kind: "link", ...authored[0] }]);
  });

  it("wins over what the runtime would derive", async () => {
    const runtime = await booted(refund({ presentation: true, evidence: authored }));

    await runtime.invoke("refund_shipping", { order_id: "10428" });

    const [stored] = runtime.queryReceipts();
    expect(stored?.receipt.evidence).toHaveLength(1);
    expect(stored?.receipt.evidence?.[0]?.reveal).toBe("invoice-shipping");
  });

  it("is refused at authoring time when malformed", () => {
    expect(() =>
      receipt({
        entity: "Order",
        changes: CHANGES,
        evidence: [{ label: "Invoice", route: "orders/10428" }],
        result: null,
      }),
    ).toThrow(/route/);
    expect(() =>
      receipt({
        entity: "Order",
        changes: CHANGES,
        evidence: [{ route: "/orders/10428" } as never],
        result: null,
      }),
    ).toThrow(/label/);
  });
});

describe("evidence deep links: derived", () => {
  it("comes from the capability's presentation hints when nothing is authored", async () => {
    const runtime = await booted(refund({ presentation: true }));

    const result = await runtime.invoke("refund_shipping", { order_id: "10428" });

    const derived = { label: "Order #10428", route: "/orders/10428", reveal: "shipping-summary" };
    const [stored] = runtime.queryReceipts();
    expect(stored?.receipt.evidence).toEqual([derived]);
    expect(links(result)).toEqual([{ kind: "link", ...derived }]);
  });

  it("is an empty list when nothing is authored and no route is declared", async () => {
    const runtime = await booted(refund({}));

    const result = await runtime.invoke("refund_shipping", { order_id: "10428" });

    const [stored] = runtime.queryReceipts();
    expect(stored?.receipt.evidence).toEqual([]);
    expect(links(result)).toEqual([]);
  });
});

describe("evidence deep links: through the agent view", () => {
  const hideCustomer: AgentView = ({ state: view }) => {
    const { paymentToken: _t, customerId: _c, ...rest } = view;
    return rest;
  };

  it("never names a route or a field the agent view hides, while the receipt keeps everything", async () => {
    const authored: EvidenceLink[] = [
      { label: "Token", route: `/tokens/${TOKEN}`, reveal: "token-panel" },
      { label: "Customer", route: "/customers/CUS-104", reveal: "customer-card" },
      { label: "Field", route: "/orders/10428", reveal: "paymentToken" },
      { label: "Order", route: "/orders/10428", reveal: "shipping-summary" },
    ];
    const runtime = await booted(refund({ evidence: authored }), { agentView: hideCustomer });

    const result = await runtime.invoke("refund_shipping", { order_id: "10428" });

    const shown = { label: "Order", route: "/orders/10428", reveal: "shipping-summary" };
    expect(links(result)).toEqual([{ kind: "link", ...shown }]);
    expect((result.data?.receipt as { evidence?: unknown }).evidence).toEqual([shown]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("CUS-104");
    const [stored] = runtime.queryReceipts();
    expect(stored?.receipt.evidence).toEqual(authored);
  });
});
