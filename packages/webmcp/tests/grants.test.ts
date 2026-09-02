import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCapability } from "../src/capability.ts";
import type { Grant, GrantRequest } from "../src/grants.ts";
import type { PolicyEngine } from "../src/policy.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const OPERATOR = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };

const AN_HOUR = 60 * 60 * 1000;

function laterIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

type Log = { refunds: Array<Record<string, unknown>>; credits: number };

/**
 * Two consequential capabilities that would each queue an approval. A
 * grant on `refund_shipping` is what lets it run without one; `issue_credit`
 * is the sibling a refusal can point at when it holds a live grant of its
 * own. `release` lets a test hold an execution in flight.
 */
function catalog(log: Log, release?: { gate: Promise<void> }) {
  return [
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      domain: "shipping",
      intents: ["refund shipping"],
      relationships: { related: ["issue_credit"] },
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      inputSchema: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          amount: { type: "number" },
        },
      },
      execute: async (input) => {
        if (release) {
          await release.gate;
        }
        log.refunds.push(input);
        return receipt({
          entity: `Customer ${String(input.customerId)}`,
          changes: [{ field: "shipping_refunded", before: false, after: true }],
          result: { refunded: input.amount },
        });
      },
    }),
    defineCapability({
      name: "issue_credit",
      description: "Issue a store credit",
      domain: "billing",
      intents: ["issue credit"],
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string" } },
      },
      execute: () => {
        log.credits += 1;
        return "credited";
      },
    }),
  ];
}

async function booted(log: Log, options: { policy?: PolicyEngine; release?: { gate: Promise<void> } } = {}) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: catalog(log, options.release),
    actor: AGENT,
    ...(options.policy ? { policy: options.policy } : {}),
  });
  await runtime.start();
  return { model, runtime };
}

const MANDATE = {
  capability: "refund_shipping",
  scope: { customerId: "CUS-104", maxAmount: 25 },
  uses: 3,
};

type Runtime = ReturnType<typeof createAgentDeskRuntime>;

/** Issues, asserting success first so a refused fixture fails on the assertion. */
function issue(runtime: Runtime, request: GrantRequest, by = OPERATOR): Grant {
  const result = runtime.grant(request, by);
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.grant;
}

function started(runtime: Runtime) {
  return runtime
    .getSnapshot()
    .audit.filter((event) => event.kind === "execution_started");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scoped authority grants: spending a mandate", () => {
  it("turns approval_required into an execution for each use, and refuses the fourth", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);

    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });
    expect(grant.state).toBe("live");
    expect(grant.issuedBy).toEqual(OPERATOR);
    expect(grant.scope).toEqual([
      { field: "amount", kind: "bound", max: 25 },
      { field: "customerId", kind: "exact", value: "CUS-104" },
    ]);

    for (const attempt of [1, 2, 3]) {
      const result = await runtime.invoke("refund_shipping", {
        customerId: "CUS-104",
        amount: 10,
      });
      expect(result.data?.status, `use ${attempt}`).toBe("COMPLETED");
    }
    expect(log.refunds).toHaveLength(3);
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(runtime.getGrant(grant.id)).toMatchObject({
      state: "exhausted",
      remaining: 0,
    });

    const fourth = await runtime.invoke("refund_shipping", {
      customerId: "CUS-104",
      amount: 10,
    });
    expect(fourth.code).toBe("GRANT_REFUSED");
    expect(fourth.isError).toBe(true);
    expect(fourth.data).toMatchObject({
      status: "GRANT_REFUSED",
      capability: "refund_shipping",
      grant_id: grant.id,
      reasonCode: "GRANT_EXHAUSTED",
    });
    expect(typeof fourth.data?.reason).toBe("string");
    expect(fourth.data).not.toHaveProperty("changes");
    expect(log.refunds).toHaveLength(3);
    expect(runtime.getSnapshot().pending).toEqual([]);
  });

  it("names the grant on the receipt and on execution_started", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    const [stored] = runtime.queryReceipts({ capability: "refund_shipping" });
    expect(stored?.grantId).toBe(grant.id);
    expect(runtime.queryReceipts({ grantId: grant.id })).toHaveLength(1);
    const [event] = started(runtime);
    expect(event).toMatchObject({
      kind: "execution_started",
      capability: "refund_shipping",
      grantId: grant.id,
    });
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "live", remaining: 2 });
  });

  it("does not spend a second use on an idempotent replay", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const call = {
      name: "refund_shipping",
      input: { customerId: "CUS-104", amount: 5 },
      idempotency_key: "refund-once",
    };
    const first = await runtime.invoke("invoke_capability", call);
    const replay = await runtime.invoke("invoke_capability", call);

    expect(first.data?.status).toBe("COMPLETED");
    expect(replay.data).toEqual(first.data);
    expect(log.refunds).toHaveLength(1);
    expect(runtime.getGrant(grant.id)).toMatchObject({ remaining: 2 });
  });
});

describe("scoped authority grants: scope is per field and never a wildcard", () => {
  it("refuses an amount over the bound without executing", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const over = await runtime.invoke("refund_shipping", {
      customerId: "CUS-104",
      amount: 30,
    });

    expect(over.code).toBe("GRANT_REFUSED");
    expect(over.data).toMatchObject({
      reasonCode: "GRANT_OUT_OF_SCOPE",
      grant_id: grant.id,
    });
    expect(String(over.data?.reason)).toContain("amount");
    expect(log.refunds).toEqual([]);
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "live", remaining: 3 });
  });

  it("refuses an input that does not carry a scoped field", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const anonymous = await runtime.invoke("refund_shipping", { amount: 10 });

    expect(anonymous.code).toBe("GRANT_REFUSED");
    expect(anonymous.data?.reasonCode).toBe("GRANT_OUT_OF_SCOPE");
    expect(String(anonymous.data?.reason)).toContain("customerId");
    expect(log.refunds).toEqual([]);
  });

  it("refuses a different identity even when the amount is in bounds", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const other = await runtime.invoke("refund_shipping", {
      customerId: "CUS-105",
      amount: 1,
    });

    expect(other.code).toBe("GRANT_REFUSED");
    expect(other.data?.reasonCode).toBe("GRANT_OUT_OF_SCOPE");
    expect(log.refunds).toEqual([]);
  });
});

describe("scoped authority grants: revocation, expiry, and concurrency", () => {
  it("revoke refuses the next use mid-flight and leaves the committed one alone", async () => {
    const log: Log = { refunds: [], credits: 0 };
    let open: () => void = () => {};
    const release = { gate: new Promise<void>((resolve) => (open = resolve)) };
    const { runtime } = await booted(log, { release });
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const inFlight = runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });
    expect(started(runtime)).toHaveLength(1);

    const revoked = runtime.revokeGrant(grant.id, OPERATOR);
    expect(revoked).toMatchObject({
      ok: true,
      grant: { state: "revoked", remaining: 2, revokedBy: OPERATOR },
    });

    const next = await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });
    expect(next.code).toBe("GRANT_REFUSED");
    expect(next.data?.reasonCode).toBe("GRANT_REVOKED");

    open();
    const first = await inFlight;
    expect(first.data?.status).toBe("COMPLETED");
    expect(log.refunds).toHaveLength(1);
    expect(runtime.queryReceipts({ grantId: grant.id })).toHaveLength(1);
    expect(started(runtime)).toHaveLength(1);
  });

  it("an expired grant refuses and reports itself expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: "2026-09-03T00:00:00Z" });

    vi.setSystemTime(new Date("2026-09-03T00:00:01Z"));
    const late = await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    expect(late.code).toBe("GRANT_REFUSED");
    expect(late.data?.reasonCode).toBe("GRANT_EXPIRED");
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "expired", remaining: 3 });
    expect(log.refunds).toEqual([]);
  });

  it("two concurrent calls against one remaining use start exactly one execution", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, uses: 1, expiresAt: laterIso(AN_HOUR) });

    const [a, b] = await Promise.all([
      runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 }),
      runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 6 }),
    ]);

    const outcomes = [a, b].map((result) => result.data?.status).sort();
    expect(outcomes).toEqual(["COMPLETED", "GRANT_REFUSED"]);
    expect(started(runtime)).toHaveLength(1);
    expect(log.refunds).toHaveLength(1);
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "exhausted", remaining: 0 });
  });
});

describe("scoped authority grants: a grant never widens policy", () => {
  it("under a deny-all policy a valid grant executes nothing and registers nothing", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime, model } = await booted(log, {
      policy: ({ capability }) => ({ kind: "deny", reason: `${capability.name} is denied` }),
    });
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const result = await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    expect(result.code).toBe("POLICY_DENIED");
    expect(started(runtime)).toHaveLength(0);
    expect(log.refunds).toEqual([]);
    expect([...model.tools.keys()].sort()).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "live", remaining: 3 });
  });

  it("under allow a grant is a no-op that records nothing", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log, {
      policy: () => ({ kind: "allow" }),
    });
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const result = await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    expect(result.data?.status).toBe("COMPLETED");
    expect(started(runtime)[0]).not.toHaveProperty("grantId");
    expect(runtime.queryReceipts()[0]).not.toHaveProperty("grantId");
    expect(runtime.getGrant(grant.id)).toMatchObject({ state: "live", remaining: 3 });
  });
});

describe("scoped authority grants: who may issue one", () => {
  it("an agent-issued grant throws at the identity boundary", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const request = { ...MANDATE, expiresAt: laterIso(AN_HOUR) };

    expect(() => runtime.grant(request, AGENT)).toThrow(TypeError);
    // The ambient actor is the agent, so relying on it throws the same way.
    expect(() => runtime.grant(request)).toThrow(TypeError);
    // A malformed identity is refused before its kind is even read.
    expect(() => runtime.grant(request, { kind: "human" } as never)).toThrow(TypeError);
    expect(runtime.listGrants()).toEqual([]);
  });

  it("an agent cannot revoke either", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    expect(() => runtime.revokeGrant(grant.id, AGENT)).toThrow(TypeError);
    expect(runtime.getGrant(grant.id)?.state).toBe("live");
  });

  it("refuses a malformed request with a reason rather than minting it", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);

    expect(
      runtime.grant({ ...MANDATE, capability: "no_such_thing", expiresAt: laterIso(AN_HOUR) }, OPERATOR),
    ).toMatchObject({ ok: false });
    expect(
      runtime.grant({ ...MANDATE, uses: 0, expiresAt: laterIso(AN_HOUR) }, OPERATOR),
    ).toMatchObject({ ok: false });
    expect(
      runtime.grant({ ...MANDATE, expiresAt: laterIso(-AN_HOUR) }, OPERATOR),
    ).toMatchObject({ ok: false });
    expect(
      runtime.grant({ ...MANDATE, scope: { customerId: { nested: true } as never }, expiresAt: laterIso(AN_HOUR) }, OPERATOR),
    ).toMatchObject({ ok: false });
    expect(runtime.listGrants()).toEqual([]);

    const valid = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });
    expect(runtime.listGrants().map((entry) => entry.id)).toEqual([valid.id]);
  });
});

describe("scoped authority grants: the result protocol", () => {
  it("a refusal names a sibling capability holding a live grant in nowPossible", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    issue(runtime, { ...MANDATE, uses: 1, expiresAt: laterIso(AN_HOUR) });
    issue(runtime, {
      capability: "issue_credit",
      scope: { customerId: "CUS-104" },
      uses: 1,
      expiresAt: laterIso(AN_HOUR),
    });
    await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    const refused = await runtime.invoke("refund_shipping", { customerId: "CUS-104", amount: 5 });

    expect(refused.code).toBe("GRANT_REFUSED");
    expect(refused.data?.nowPossible).toContain("issue_credit");
    expect(refused.data?.evidence).toEqual([]);
    expect(refused.data).not.toHaveProperty("repair");
    expect(runtime.getSnapshot().grants.map((grant) => grant.state).sort()).toEqual([
      "exhausted",
      "live",
    ]);
  });

  it("listGrants hands out detached records", async () => {
    const log: Log = { refunds: [], credits: 0 };
    const { runtime } = await booted(log);
    const grant = issue(runtime, { ...MANDATE, expiresAt: laterIso(AN_HOUR) });

    const [listed] = runtime.listGrants();
    expect(listed).toEqual(grant);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listed as { remaining: number }).remaining = 99;
    }).toThrow();
    expect(runtime.getGrant(grant.id)?.remaining).toBe(3);
  });
});
