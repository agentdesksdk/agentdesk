import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const OPERATOR = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };

/**
 * Two consequential capabilities. A grant on `refund_shipping` is spent,
 * so its next approval was queued after a grant that did not apply;
 * `issue_credit` never had a grant, so its approval was queued with nothing
 * consulted. Each pending action has to say which it was, itself.
 */
function catalog() {
  return [
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string" }, amount: { type: "number" } },
      },
      execute: () => "refunded",
    }),
    defineCapability({
      name: "issue_credit",
      description: "Issue a store credit",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      execute: () => "credited",
    }),
  ];
}

describe("a pending action carries the grant that was considered", () => {
  it("reports its own grant state on each of two approvals queued in quick succession", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog(),
      actor: AGENT,
    });
    await runtime.start();
    const issued = runtime.grant(
      {
        capability: "refund_shipping",
        scope: { customerId: "CUS-104" },
        uses: 1,
        expiresAt: Date.now() + 60_000,
      },
      OPERATOR,
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      throw new Error(issued.reason);
    }
    // Spend the only use, so the next call is queued after an exhausted grant.
    await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    const [afterGrant, withoutGrant] = await Promise.all([
      runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 }),
      runtime.invoke("issue_credit", {}),
    ]);

    expect(afterGrant.code).toBe("APPROVAL_REQUIRED");
    expect(withoutGrant.code).toBe("APPROVAL_REQUIRED");
    const pending = runtime.getSnapshot().pending;
    expect(pending).toHaveLength(2);
    const refund = pending.find((action) => action.capability === "refund_shipping");
    const credit = pending.find((action) => action.capability === "issue_credit");
    expect(refund?.grant).toEqual({ id: issued.grant.id, outcome: "exhausted" });
    expect(refund?.grant).toEqual(afterGrant.data?.grant);
    expect(credit).not.toHaveProperty("grant");
  });

  it("carries the scope outcome with its field and bound", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog(),
      actor: AGENT,
    });
    await runtime.start();
    const issued = runtime.grant(
      {
        capability: "refund_shipping",
        scope: { customerId: "CUS-104", maxAmount: 25 },
        uses: 3,
        expiresAt: Date.now() + 60_000,
      },
      OPERATOR,
    );
    if (!issued.ok) {
      throw new Error(issued.reason);
    }

    await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 40 });

    expect(runtime.getSnapshot().pending[0]?.grant).toEqual({
      id: issued.grant.id,
      outcome: "over_bound",
      field: "amount",
      max: 25,
    });
  });
});
