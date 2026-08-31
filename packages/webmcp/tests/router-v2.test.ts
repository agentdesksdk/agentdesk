import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { rankCapabilities, routeTask } from "../src/router.ts";

function graphCatalog() {
  return [
    // Shares no token, domain, entity, or route with the refund query, so
    // the deterministic scorer cannot reach it. Only the graph can.
    defineCapability({
      name: "verify_payment_captured",
      title: "Verify payment captured",
      description: "Confirm the original payment settled before reversing it",
      domain: "billing",
      intents: ["settlement state"],
      keywords: ["settled", "capture"],
      execute: () => ({ captured: true }),
    }),
    defineCapability({
      name: "get_order_shipping",
      description: "Read the shipping fee on an order",
      domain: "shipping",
      keywords: ["fee"],
      execute: () => ({ fee: 12 }),
    }),
    defineCapability({
      name: "refund_shipping",
      title: "Refund shipping",
      description: "Refund the shipping fee for an order",
      domain: "shipping",
      intents: ["refund shipping"],
      entities: ["orderId"],
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      relationships: { requires: ["verify_payment_captured"], related: ["issue_credit"] },
      execute: () => ({ shipping_refunded: true }),
    }),
    ...Array.from({ length: 12 }, (_, i) =>
      defineCapability({
        name: `unrelated_${i}`,
        description: "Something else entirely",
        execute: () => ({}),
      }),
    ),
  ];
}

const ORDER_CTX = { route: "/orders/10428", state: { orderId: "10428" } };
const REFUND_QUERY = "refund the shipping fee for this order";
const REQUEST = { query: REFUND_QUERY, context: ORDER_CTX };

describe("routing strategies", () => {
  it("is deterministic by default and matches the v1 scorer exactly", async () => {
    const pool = graphCatalog();
    const result = await routeTask(pool, REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("deterministic");
    expect(result.scoredExternally).toBe(false);
    expect(result.matches.map((m) => m.capability.name)).toEqual(
      rankCapabilities(pool, ORDER_CTX, REFUND_QUERY).map((m) => m.capability.name),
    );
  });

  it("pulls in the prerequisite step without exposing the catalog", async () => {
    const pool = graphCatalog();
    const before = rankCapabilities(pool, ORDER_CTX, REFUND_QUERY).map(
      (m) => m.capability.name,
    );
    const result = await routeTask(pool, REQUEST, { kind: "hybrid" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.matches.map((m) => m.capability.name);

    expect(before).not.toContain("verify_payment_captured");
    expect(names[0]).toBe("refund_shipping");
    expect(names).toContain("verify_payment_captured");
    expect(names.length).toBeLessThanOrEqual(6);
    expect(names.filter((n) => n.startsWith("unrelated_"))).toEqual([]);
  });

  it("names why a capability was pulled in", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, { kind: "hybrid" });
    if (!result.ok) return;
    const pulled = result.matches.find((m) => m.capability.name === "verify_payment_captured");
    expect(pulled?.reasons).toContain("required by refund_shipping");
  });

  it("ignores a relationship naming a capability the catalog does not hold", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, { kind: "hybrid" });
    if (!result.ok) return;
    expect(result.matches.map((m) => m.capability.name)).not.toContain("issue_credit");
  });

  it("filters on eligibility before ranking, so a scorer never sees the rest", async () => {
    const seen: string[] = [];
    const result = await routeTask(
      graphCatalog(),
      REQUEST,
      {
        kind: "custom",
        scorer: (candidates) => {
          seen.push(...candidates.map((c) => c.name));
          return candidates.map((capability) => ({
            capability,
            score: 1,
            reasons: ["custom"],
          }));
        },
      },
      (capability) => capability.name !== "refund_shipping",
    );

    expect(seen).not.toContain("refund_shipping");
    if (!result.ok) return;
    expect(result.matches.map((m) => m.capability.name)).not.toContain("refund_shipping");
  });

  it("returns the same order for the same query every time", async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        routeTask(
          graphCatalog(),
          { ...REQUEST, session: ["verify_payment_captured"] },
          { kind: "hybrid" },
        ),
      ),
    );
    const orders = runs.map((r) =>
      r.ok ? r.matches.map((m) => `${m.capability.name}:${m.score}`).join("|") : "failed",
    );
    expect(new Set(orders).size).toBe(1);
  });

  it("breaks a tie by name rather than by input order", async () => {
    const tied = ["b_report", "a_report", "c_report"].map((name) =>
      defineCapability({
        name,
        description: "A report",
        keywords: ["report"],
        execute: () => ({}),
      }),
    );
    const result = await routeTask(
      tied,
      { query: "report", context: { route: "/", state: {} } },
      { kind: "hybrid" },
    );
    if (!result.ok) return;
    expect(result.matches.map((m) => m.capability.name)).toEqual([
      "a_report",
      "b_report",
      "c_report",
    ]);
  });
});

describe("a custom scorer that misbehaves", () => {
  const throwing = () => {
    throw new Error("embedding service unreachable");
  };

  it("degrades to deterministic and says so when it throws", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: throwing,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("deterministic");
    expect(result.scoredExternally).toBe(false);
    expect(result.degradedFrom).toBe("custom");
    expect(result.degradedBecause).toMatch(/embedding service unreachable/);
    expect(result.matches[0]?.capability.name).toBe("refund_shipping");
  });

  it("returns a structured refusal when the caller asked for one", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: throwing,
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.strategy).toBe("custom");
    expect(result.reason).toMatch(/embedding service unreachable/);
  });

  it("refuses a scorer that invents a capability it was not offered", async () => {
    const smuggled = defineCapability({
      name: "delete_everything",
      description: "Not in the pool",
      execute: () => ({}),
    });
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: () => [{ capability: smuggled, score: 99, reasons: ["custom"] }],
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not offered/);
  });

  it("refuses a scorer that returns a non-finite score", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: (candidates) =>
        candidates.map((capability) => ({
          capability,
          score: Number.NaN,
          reasons: ["custom"],
        })),
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/finite score/);
  });

  it("only claims external scoring when a scorer produced the order", async () => {
    const good = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: (candidates) =>
        candidates.map((capability, i) => ({
          capability,
          score: candidates.length - i,
          reasons: ["custom"],
        })),
    });
    expect(good.ok && good.scoredExternally).toBe(true);

    const hybridRun = await routeTask(graphCatalog(), REQUEST, { kind: "hybrid" });
    expect(hybridRun.ok && hybridRun.scoredExternally).toBe(false);
  });

  it("survives an async scorer that rejects", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: async () => {
        throw new Error("timed out");
      },
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
  });
});

describe("relationships are normalized at definition time", () => {
  it("always presents both arrays, so routing never guards for undefined", () => {
    const bare = defineCapability({
      name: "bare",
      description: "Declares no relationships",
      execute: () => ({}),
    });
    const partial = defineCapability({
      name: "partial",
      description: "Declares only requires",
      relationships: { requires: ["bare"] },
      execute: () => ({}),
    });

    expect(bare.relationships).toEqual({ requires: [], related: [] });
    expect(partial.relationships.related).toEqual([]);
    expect(partial.relationships.requires).toEqual(["bare"]);
  });
});

describe("eligibility filtering applies to every strategy", () => {
  it("keeps an ineligible capability out of hybrid results and out of the graph", async () => {
    const result = await routeTask(
      graphCatalog(),
      REQUEST,
      { kind: "hybrid" },
      (capability) => capability.name !== "verify_payment_captured",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.matches.map((m) => m.capability.name);
    expect(names).toContain("refund_shipping");
    // The anchor still declares it in `requires`; the filter is what stops it.
    expect(names).not.toContain("verify_payment_captured");
  });
});
