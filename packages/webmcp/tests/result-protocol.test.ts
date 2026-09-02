import { describe, expect, it } from "vitest";
import { AVAILABLE, defineCapability, unavailable } from "../src/capability.ts";
import { riskBasedPolicy, type PolicyEngine } from "../src/policy.ts";
import type { Refusal, Settled } from "../src/protocol.ts";
import {
  approvalRequired,
  completed,
  policyDenied,
  receipt,
  type ToolResult,
} from "../src/results.ts";
import { MAX_ROUTED } from "../src/router.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

type Store = { verified: boolean; refunded: boolean; credited: boolean };

const DENIED = "verify_customer_identity";

/**
 * Four capabilities around one refusal. `refund_shipping` is blocked until
 * the customer is verified, names `verify_customer_identity` as its repair
 * with the input to call it with, and once refunded points at
 * `issue_credit` instead.
 */
function catalog(store: Store) {
  return [
    defineCapability({
      name: "verify_customer_identity",
      description: "Verify a customer's identity before a refund",
      domain: "customers",
      intents: ["verify identity"],
      risk: "WRITE",
      execute: () => {
        store.verified = true;
        return receipt({
          entity: "Customer CUS-104",
          changes: [{ field: "identity_verified", before: false, after: true }],
          result: { verified: true },
        });
      },
    }),
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      domain: "shipping",
      intents: ["refund shipping"],
      relationships: {
        requires: ["verify_customer_identity"],
        related: ["issue_credit"],
      },
      risk: "WRITE",
      availability: () =>
        !store.verified
          ? unavailable("NOT_VERIFIED", "Order is not identity-verified", {
              capability: "verify_customer_identity",
              input: { customerId: "CUS-104" },
            })
          : store.refunded
            ? unavailable(
                "ALREADY_REFUNDED",
                "Shipping has already been refunded for this order.",
                "issue_credit",
              )
            : AVAILABLE,
      execute: () => {
        store.refunded = true;
        return receipt({
          entity: "Order #10428",
          changes: [{ field: "shipping_refunded", before: false, after: true }],
          result: { shipping_refunded: true },
        });
      },
    }),
    defineCapability({
      name: "issue_credit",
      description: "Issue a store credit to a customer",
      domain: "billing",
      intents: ["issue credit"],
      risk: "WRITE",
      availability: () =>
        store.credited
          ? unavailable("ALREADY_CREDITED", "A credit was already issued.")
          : AVAILABLE,
      execute: () => {
        store.credited = true;
        return "credited";
      },
    }),
    defineCapability({
      name: "get_order",
      description: "Read an order",
      domain: "orders",
      intents: ["get order"],
      execute: () => ({ order_id: "10428" }),
    }),
  ];
}

function denying(...names: string[]): PolicyEngine {
  return (request) =>
    names.includes(request.capability.name)
      ? { kind: "deny", reason: `${request.capability.name} is denied here` }
      : riskBasedPolicy(request);
}

const DENY_ALL: PolicyEngine = ({ capability }) => ({
  kind: "deny",
  reason: `${capability.name} is denied`,
});

function text(result: ToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}

async function booted(store: Store, policy?: PolicyEngine) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: catalog(store),
    ...(policy ? { policy } : {}),
  });
  await runtime.start();
  return { model, runtime };
}

describe("one result protocol: a refusal", () => {
  it("never names a policy-denied capability as its repair, in any field", async () => {
    const { runtime } = await booted(
      { verified: false, refunded: false, credited: false },
      denying(DENIED),
    );

    const refused = await runtime.invoke("refund_shipping", { order_id: "10428" });

    expect(refused.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(refused.data?.reason).toBe("Order is not identity-verified");
    expect(refused.data?.repair).toBeUndefined();
    expect(refused.data?.suggestedCapability).toBeUndefined();
    expect(refused.data?.nowPossible).not.toContain(DENIED);
    expect(refused.data?.blockedCapabilities).toEqual(["refund_shipping"]);
    expect(text(refused)).not.toContain(DENIED);
    expect(JSON.stringify(refused.data)).not.toContain(DENIED);
  });

  it("carries the repair, with its input, when the repair is routable and available", async () => {
    const { runtime } = await booted({
      verified: false,
      refunded: false,
      credited: false,
    });

    const refused = await runtime.invoke("refund_shipping", { order_id: "10428" });

    expect(refused.data).toMatchObject({
      status: "CAPABILITY_UNAVAILABLE",
      reason: "Order is not identity-verified",
      // The repair and the related alternative are both callable right now.
      nowPossible: ["issue_credit", "verify_customer_identity"],
      blockedCapabilities: ["refund_shipping"],
      repair: {
        capability: "verify_customer_identity",
        input: { customerId: "CUS-104" },
      },
      suggestedCapability: "verify_customer_identity",
      evidence: [],
    });
    expect(refused.data).not.toHaveProperty("changes");
  });

  it("drops a repair that cannot run now and lists it as blocked instead", async () => {
    const { runtime } = await booted({
      verified: true,
      refunded: true,
      credited: true,
    });

    const refused = await runtime.invoke("refund_shipping", { order_id: "10428" });

    expect(refused.data?.reasonCode).toBe("ALREADY_REFUNDED");
    expect(refused.data?.repair).toBeUndefined();
    expect(refused.data?.suggestedCapability).toBeUndefined();
    expect(refused.data?.blockedCapabilities).toEqual([
      "issue_credit",
      "refund_shipping",
    ]);
    // The prerequisite is still callable, so it is the only thing possible.
    expect(refused.data?.nowPossible).toEqual(["verify_customer_identity"]);
  });

  it("names only capabilities the agent can actually call in nowPossible", async () => {
    const store: Store = { verified: false, refunded: false, credited: false };
    const { runtime, model } = await booted(store, denying("issue_credit"));
    await model.execute("find_capabilities", { query: "refund shipping" });

    const refused = await runtime.invoke("refund_shipping", { order_id: "10428" });
    const possible = refused.data?.nowPossible as string[];

    expect(possible.length).toBeGreaterThan(0);
    expect(possible).not.toContain("issue_credit");
    for (const name of possible) {
      const attempt = await runtime.invoke(name, { customerId: "CUS-104" });
      expect(attempt.code).not.toBe("POLICY_DENIED");
      expect(attempt.code).not.toBe("CAPABILITY_UNAVAILABLE");
    }
  });

  it("gives POLICY_DENIED the same answers, with the denied capability in none of them", async () => {
    const { runtime } = await booted(
      { verified: true, refunded: false, credited: false },
      denying(DENIED),
    );

    const denied = await runtime.invoke(DENIED, { customerId: "CUS-104" });

    expect(denied.code).toBe("POLICY_DENIED");
    expect(denied.data?.nowPossible).toBeDefined();
    expect(denied.data?.nowPossible).not.toContain(DENIED);
    expect(denied.data?.blockedCapabilities).toEqual([]);
    expect(denied.data?.repair).toBeUndefined();
    expect(denied.data?.evidence).toEqual([]);
  });

  it("gives VALIDATION_FAILED a reason and the capability itself as the repair", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "set_quantity",
          description: "Set a quantity",
          inputSchema: {
            type: "object",
            properties: { quantity: { type: "integer" } },
            required: ["quantity"],
          },
          execute: () => "set",
        }),
      ],
    });
    await runtime.start();

    const invalid = await runtime.invoke("set_quantity", { quantity: "many" });

    expect(invalid.code).toBe("VALIDATION_FAILED");
    expect(typeof invalid.data?.reason).toBe("string");
    expect(invalid.data?.repair).toEqual({ capability: "set_quantity" });
    expect(invalid.data?.nowPossible).toEqual(["set_quantity"]);
    expect(invalid.data?.blockedCapabilities).toEqual([]);
  });
});

describe("one result protocol: under a deny-all policy", () => {
  it("every field of every result is empty and no name, description, or schema leaks", async () => {
    const store: Store = { verified: false, refunded: false, credited: false };
    const names = catalog(store).map((capability) => capability.name);
    const descriptions = catalog(store).map((capability) => capability.description);
    const { runtime, model } = await booted(store, DENY_ALL);

    const routed = (await model.execute("find_capabilities", {
      query: "refund shipping for the order",
    })) as ToolResult;
    const report = JSON.parse(text(routed)) as Record<string, unknown>;
    expect(report.matches).toEqual([]);
    expect(report.nowPossible).toEqual([]);
    expect(report.blockedCapabilities).toEqual([]);
    expect(report.activated_tools).toEqual([]);
    for (const leak of [...names, ...descriptions]) {
      expect(text(routed)).not.toContain(leak);
    }
    expect([...model.tools.keys()].sort()).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);

    for (const name of names) {
      const result = await runtime.invoke(name, {});
      expect(result.code).toBe("POLICY_DENIED");
      expect(result.data?.nowPossible).toEqual([]);
      expect(result.data?.blockedCapabilities).toEqual([]);
      expect(result.data?.repair).toBeUndefined();
      expect(result.data?.suggestedCapability).toBeUndefined();
    }
  });

  it("registers no native tool for a denied capability in flat exposure either", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: catalog({ verified: true, refunded: false, credited: false }),
      exposure: "flat",
      policy: denying(DENIED),
    });
    await runtime.start();

    expect(model.tools.has(DENIED)).toBe(false);
    expect(model.tools.has("refund_shipping")).toBe(true);
  });
});

describe("one result protocol: a success", () => {
  it("reports what changed and the evidence that proves it, and never a repair", async () => {
    const store: Store = { verified: false, refunded: false, credited: false };
    const { runtime } = await booted(store);

    const done = await runtime.invoke("verify_customer_identity", {
      customerId: "CUS-104",
    });

    expect(done.isError).toBeUndefined();
    expect(done.data).toMatchObject({
      status: "COMPLETED",
      result: { verified: true },
      changes: [{ field: "identity_verified", before: false, after: true }],
    });
    expect(done.data?.evidence).toEqual(
      expect.arrayContaining([
        { kind: "receipt", id: expect.stringMatching(/^RCPT-/) },
        { kind: "execution", id: expect.stringMatching(/^EXE-/) },
      ]),
    );
    const [stored] = runtime.queryReceipts({ capability: "verify_customer_identity" });
    expect(done.data?.evidence).toContainEqual({ kind: "receipt", id: stored!.id });
    // The write moved the situation: refund_shipping is now possible.
    expect(done.data?.nowPossible).toContain("refund_shipping");
    expect(done.data).not.toHaveProperty("repair");
    expect(done.data).not.toHaveProperty("reason");
    expect(JSON.parse(text(done))).toMatchObject({
      status: "COMPLETED",
      changes: [{ field: "identity_verified", before: false, after: true }],
      nowPossible: expect.arrayContaining(["refund_shipping"]),
    });
  });

  it("keeps a plain value's content byte for byte and puts the answers in data", async () => {
    const { runtime } = await booted({
      verified: true,
      refunded: false,
      credited: false,
    });

    const read = await runtime.invoke("get_order", {});

    expect(read.content).toEqual([{ type: "text", text: '{"order_id":"10428"}' }]);
    expect(read.data).toMatchObject({
      status: "COMPLETED",
      result: { order_id: "10428" },
      changes: [],
      blockedCapabilities: [],
    });
    expect(read.data?.evidence).toContainEqual({
      kind: "execution",
      id: expect.stringMatching(/^EXE-/),
    });
    expect(read.data).not.toHaveProperty("repair");
  });

  it("lists the capability the write just spent as blocked", async () => {
    const { runtime } = await booted({
      verified: true,
      refunded: false,
      credited: false,
    });

    const done = await runtime.invoke("refund_shipping", { order_id: "10428" });

    expect(done.data?.status).toBe("COMPLETED");
    expect(done.data?.blockedCapabilities).toEqual(["refund_shipping"]);
    expect(done.data?.nowPossible).toEqual(["issue_credit", "verify_customer_identity"]);
  });
});

describe("one result protocol: a pending approval", () => {
  it("carries the approval as evidence and no repair", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "cancel_order",
          description: "Cancel an order",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: () => "cancelled",
        }),
      ],
    });
    await runtime.start();

    const pending = await runtime.invoke("cancel_order", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    expect(pending.code).toBe("APPROVAL_REQUIRED");
    expect(pending.data?.evidence).toEqual([{ kind: "approval", id: actionId }]);
    expect(pending.data?.nowPossible).toEqual(["cancel_order"]);
    expect(pending.data?.blockedCapabilities).toEqual([]);
    expect(pending.data).not.toHaveProperty("repair");
    expect(pending.data).not.toHaveProperty("changes");
  });

  it("a refusal at approval time names the approval as its evidence", async () => {
    const store: Store = { verified: true, refunded: false, credited: false };
    let deny = false;
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      policy: ({ capability }) =>
        deny && capability.name === "cancel_order"
          ? { kind: "deny", reason: "window closed" }
          : capability.policy.kind === "approval_required"
            ? { kind: "require_approval" }
            : { kind: "allow" },
      capabilities: [
        ...catalog(store),
        defineCapability({
          name: "cancel_order",
          description: "Cancel an order",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: () => "cancelled",
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("cancel_order", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;

    deny = true;
    const refused = await runtime.approve(actionId, {
      id: "operator",
      name: "Operator",
      kind: "human",
    });

    expect(refused.code).toBe("POLICY_DENIED");
    expect(refused.data?.evidence).toEqual([{ kind: "approval", id: actionId }]);
    expect(refused.data?.nowPossible).not.toContain("cancel_order");
    expect(refused.data?.blockedCapabilities).not.toContain("cancel_order");
  });
});

describe("one result protocol: the routing report", () => {
  it("answers the same questions and filters each match's repair the same way", async () => {
    const store: Store = { verified: false, refunded: false, credited: false };
    const { model } = await booted(store, denying(DENIED));

    const routed = (await model.execute("find_capabilities", {
      query: "refund shipping",
    })) as ToolResult;
    const report = JSON.parse(text(routed)) as {
      matches: Array<Record<string, unknown>>;
      nowPossible: string[];
      blockedCapabilities: string[];
      evidence: unknown[];
    };

    const refund = report.matches.find((match) => match.name === "refund_shipping");
    expect(refund).toMatchObject({
      available: false,
      reasonCode: "NOT_VERIFIED",
      reason: "Order is not identity-verified",
    });
    expect(refund?.repair).toBeUndefined();
    expect(refund?.suggestedCapability).toBeUndefined();
    expect(report.matches.map((match) => match.name)).not.toContain(DENIED);
    expect(report.nowPossible).not.toContain(DENIED);
    expect(report.blockedCapabilities).toEqual(["refund_shipping"]);
    expect(report.evidence).toEqual([]);
    expect(text(routed)).not.toContain(DENIED);
  });

  it("carries a routable repair on a match with its input, and the derived alias", async () => {
    const store: Store = { verified: false, refunded: false, credited: false };
    const { model, runtime } = await booted(store);

    const routed = (await model.execute("find_capabilities", {
      query: "refund shipping",
    })) as ToolResult;
    const report = JSON.parse(text(routed)) as {
      matches: Array<Record<string, unknown>>;
      nowPossible: string[];
    };

    const refund = report.matches.find((match) => match.name === "refund_shipping");
    expect(refund?.repair).toEqual({
      capability: "verify_customer_identity",
      input: { customerId: "CUS-104" },
    });
    expect(refund?.suggestedCapability).toBe("verify_customer_identity");
    expect(report.nowPossible).toContain("verify_customer_identity");
    const snapshotMatch = runtime
      .getSnapshot()
      .lastRouting?.matches.find((match) => match.name === "refund_shipping");
    expect(snapshotMatch?.repair).toEqual({
      capability: "verify_customer_identity",
      input: { customerId: "CUS-104" },
    });
    expect(snapshotMatch?.suggestedCapability).toBe("verify_customer_identity");
  });
});

describe("one result protocol: a retired tool", () => {
  it("points at find_capabilities and reports where the retired capability stands", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "get_invoice",
          description: "Read an invoice",
          domain: "billing",
          intents: ["get invoice"],
          availability: (ctx) =>
            ctx.state.invoicesHidden === true
              ? unavailable("INVOICES_HIDDEN", "Invoices are hidden on this route.")
              : AVAILABLE,
          execute: () => "invoice",
        }),
      ],
    });
    await runtime.start();
    await model.execute("find_capabilities", { query: "get invoice" });
    expect(model.tools.has("get_invoice")).toBe(true);

    await runtime.setContext({ route: "/", state: { invoicesHidden: true } });
    const retired = (await model.execute("get_invoice", {})) as ToolResult;

    expect(retired.code).toBe("TOOL_RETIRED");
    expect(retired.data?.repair).toEqual({ capability: "find_capabilities" });
    expect(retired.data?.blockedCapabilities).toEqual(["get_invoice"]);
    expect(retired.data?.nowPossible).toEqual([]);
    expect(retired.data?.evidence).toEqual([]);
  });
});

describe("one result protocol: illegal states are not constructible", () => {
  it("a success builder refuses a situation that names a repair", () => {
    const refusal: Refusal = {
      nowPossible: [],
      blockedCapabilities: [],
      evidence: [],
      repair: { capability: "verify_customer_identity" },
    };
    const settled: Settled = {
      nowPossible: [],
      blockedCapabilities: [],
      evidence: [],
    };
    // @ts-expect-error a completed result cannot carry a repair
    completed({ ok: true }, undefined, { ...refusal, changes: [] });
    // @ts-expect-error a pending approval cannot carry a repair
    approvalRequired("cancel_order", "APR-1", "CONSEQUENTIAL", "s", [], "summary", refusal);
    // A refusal may or may not name one; both compile and neither carries changes.
    const denied = policyDenied("cancel_order", "denied", refusal);
    const bare = policyDenied("cancel_order", "denied", settled);
    expect(denied.data?.repair).toEqual({ capability: "verify_customer_identity" });
    expect(bare.data).not.toHaveProperty("repair");
    expect(denied.data).not.toHaveProperty("changes");
  });
});

describe("one result protocol: the surface budget holds", () => {
  it("never registers more than the bootstrap tools plus MAX_ROUTED, and never a denied one", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: Array.from({ length: 12 }, (_, i) =>
        defineCapability({
          name: `cap_${i}`,
          description: `Capability ${i}`,
          intents: ["do the thing"],
          execute: () => i,
        }),
      ),
      policy: ({ capability }) =>
        Number(capability.name.split("_")[1]) % 2 === 0
          ? { kind: "deny", reason: "even capabilities are denied" }
          : { kind: "allow" },
    });
    await runtime.start();

    await model.execute("find_capabilities", { query: "do the thing" });

    expect(model.tools.size).toBeLessThanOrEqual(4 + MAX_ROUTED);
    for (const name of model.tools.keys()) {
      expect(name).not.toMatch(/^cap_(0|2|4|6|8|10)$/);
    }
  });
});
