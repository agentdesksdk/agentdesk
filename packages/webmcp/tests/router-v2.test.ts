import { describe, expect, it } from "vitest";
import { defineCapability, type Capability } from "../src/capability.ts";
import {
  rankCapabilities,
  routeTask,
  type RoutingResult,
} from "../src/router.ts";

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
          return candidates.map((d) => ({ name: d.name, score: 1, reasons: ["custom"] }));
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
    // Reading the reason requires proving this is the degraded variant, which
    // is the point of splitting the union.
    if (!("degradedFrom" in result)) {
      throw new Error("a failed custom scorer should report what it degraded from");
    }
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
      scorer: () => [{ name: smuggled.name, score: 99, reasons: ["custom"] }],
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
        candidates.map((d) => ({ name: d.name, score: Number.NaN, reasons: ["custom"] })),
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
        candidates.map((d, i) => ({ name: d.name, score: candidates.length - i, reasons: ["custom"] })),
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

describe("the custom scorer boundary is not a suggestion", () => {
  it("cannot mutate the pool it was handed and steer the fallback", async () => {
    const smuggled = defineCapability({
      name: "unrelated_0",
      description: "Forged",
      intents: ["refund shipping"],
      execute: () => ({}),
    });
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: (candidates) => {
        (candidates as Capability[]).length = 0;
        (candidates as Capability[]).push(smuggled);
        throw new Error("now fall back");
      },
      onFailure: "deterministic",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches[0]?.capability.name).toBe("refund_shipping");
  });

  it("resolves a returned entry to the capability it actually offered", async () => {
    const forged = defineCapability({
      name: "refund_shipping",
      description: "Same name, different object",
      execute: () => ({ forged: true }),
    });
    const pool = graphCatalog();
    const result = await routeTask(pool, REQUEST, {
      kind: "custom",
      scorer: () => [{ name: forged.name, score: 9, reasons: ["custom"] }],
    });

    if (!result.ok) return;
    const real = pool.find((c) => c.name === "refund_shipping");
    expect(result.matches[0]?.capability).toBe(real);
  });

  it("refuses a scorer that returns the same capability twice", async () => {
    const pool = graphCatalog();
    const target = pool.find((c) => c.name === "refund_shipping")!;
    const result = await routeTask(pool, REQUEST, {
      kind: "custom",
      scorer: () => [
        { name: target.name, score: 9, reasons: ["custom"] },
        { name: target.name, score: 8, reasons: ["custom"] },
      ],
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/twice|duplicate/i);
  });

  it("treats a score of zero or less as not selected, like the deterministic scorer", async () => {
    const pool = graphCatalog();
    const result = await routeTask(pool, REQUEST, {
      kind: "custom",
      scorer: (candidates) =>
        candidates.map((d, i) => ({ name: d.name, score: i === 0 ? 5 : 0, reasons: ["custom"] })),
    });

    if (!result.ok) return;
    expect(result.matches).toHaveLength(1);
  });
});

describe("the budget cannot be argued with", () => {
  it("treats a negative limit as no room rather than as a slice offset", async () => {
    const result = await routeTask(
      graphCatalog(),
      { ...REQUEST, limit: -1 },
      {
        kind: "custom",
        scorer: (candidates) =>
          candidates.map((d, i) => ({ name: d.name, score: candidates.length - i, reasons: ["custom"] })),
      },
    );

    if (!result.ok) return;
    expect(result.matches.length).toBeLessThanOrEqual(6);
  });

  it("ignores a non-finite limit", async () => {
    const result = await routeTask(
      graphCatalog(),
      { ...REQUEST, limit: Number.NaN },
      { kind: "hybrid" },
    );
    if (!result.ok) return;
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(6);
  });
});

describe("hybrid scores the whole pool before it trims", () => {
  it("does not lose a low-ranked candidate's base score before its bonus", async () => {
    // Eight capabilities all match the query weakly, so the deterministic
    // top six is full before the graph is consulted. The anchor requires the
    // one ranked last by name, which is exactly the one an early truncation
    // would have discarded.
    const filler = Array.from({ length: 7 }, (_, i) =>
      defineCapability({
        name: `zz_report_${i}`,
        description: "A report",
        keywords: ["report"],
        execute: () => ({}),
      }),
    );
    const anchor = defineCapability({
      name: "aa_anchor",
      description: "A report anchor",
      keywords: ["report"],
      relationships: { requires: ["zz_report_6"] },
      execute: () => ({}),
    });

    const result = await routeTask(
      [anchor, ...filler],
      { query: "report", context: { route: "/", state: {} } },
      { kind: "hybrid" },
    );

    if (!result.ok) return;
    const pulled = result.matches.find((m) => m.capability.name === "zz_report_6");
    expect(pulled).toBeDefined();
    // Base keyword score of 2 plus the requires bonus of 3, not the bonus alone.
    expect(pulled?.score).toBe(5);
  });

  it("walks exactly one hop, so a prerequisite of a prerequisite stays out", async () => {
    const c = defineCapability({
      name: "step_c",
      description: "Third step",
      execute: () => ({}),
    });
    const b = defineCapability({
      name: "step_b",
      description: "Second step",
      relationships: { requires: ["step_c"] },
      execute: () => ({}),
    });
    const a = defineCapability({
      name: "step_a",
      description: "First step",
      keywords: ["alpha"],
      relationships: { requires: ["step_b"] },
      execute: () => ({}),
    });

    const result = await routeTask(
      [a, b, c],
      { query: "alpha", context: { route: "/", state: {} } },
      { kind: "hybrid" },
    );

    if (!result.ok) return;
    const names = result.matches.map((m) => m.capability.name);
    expect(names).toContain("step_a");
    expect(names).toContain("step_b");
    expect(names).not.toContain("step_c");
  });
});

describe("relationship arrays are owned by the capability", () => {
  it("does not change when the caller mutates the array it passed in", () => {
    const requires = ["first_step"];
    const capability = defineCapability({
      name: "second_step",
      description: "Depends on the first",
      relationships: { requires },
      execute: () => ({}),
    });

    requires.push("smuggled_step");

    expect(capability.relationships.requires).toEqual(["first_step"]);
  });
});

describe("the result type refuses to describe a run that cannot happen", () => {
  it("cannot mark custom routing as not externally scored", () => {
    const honest: RoutingResult = {
      ok: true,
      strategy: "custom",
      scoredExternally: true,
      matches: [],
    };
    const dishonest: RoutingResult = {
      ok: true,
      strategy: "custom",
      // @ts-expect-error custom routing is externally scored by definition
      scoredExternally: false,
      matches: [],
    };
    const unearned: RoutingResult = {
      ok: true,
      strategy: "hybrid",
      scoredExternally: false,
      // @ts-expect-error only a degraded run carries the reason it degraded
      degradedFrom: "custom",
      matches: [],
    };

    expect(honest.ok).toBe(true);
    expect(dishonest).toBeDefined();
    expect(unearned).toBeDefined();
  });
});

describe("deterministic routing preserves scores, not just order", () => {
  it("reports the same score as the v1 scorer for every match", async () => {
    const pool = graphCatalog();
    const result = await routeTask(pool, REQUEST);
    if (!result.ok) return;

    const v1 = rankCapabilities(pool, ORDER_CTX, REFUND_QUERY);
    expect(result.matches.map((m) => [m.capability.name, m.score])).toEqual(
      v1.map((m) => [m.capability.name, m.score]),
    );
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe("the scorer never touches an executable capability", () => {
  it("cannot replace a handler on something it was offered", async () => {
    const pool = graphCatalog();
    const target = pool.find((c) => c.name === "refund_shipping")!;
    const original = target.execute;
    let tampered = false;

    await routeTask(pool, REQUEST, {
      kind: "custom",
      scorer: (offered) => {
        const first = offered[0] as unknown as Record<string, unknown>;
        try {
          first.execute = () => {
            tampered = true;
            return { hijacked: true };
          };
        } catch {
          /* frozen, which is the point */
        }
        throw new Error("now fall back");
      },
      onFailure: "deterministic",
    });

    expect(target.execute).toBe(original);
    expect(tampered).toBe(false);
  });

  it("is handed no handler to call in the first place", async () => {
    let sawExecutable = true;
    await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: (offered) => {
        sawExecutable = offered.some(
          (d) => typeof (d as unknown as Record<string, unknown>).execute === "function",
        );
        return [];
      },
    });
    expect(sawExecutable).toBe(false);
  });

  it("turns a throwing score getter into a structured refusal", async () => {
    const result = await routeTask(graphCatalog(), REQUEST, {
      kind: "custom",
      scorer: (offered) => [
        {
          name: offered[0]!.name,
          get score(): number {
            throw new Error("score getter exploded");
          },
        },
      ],
      onFailure: "refuse",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/score getter exploded|no finite score/);
  });
});

describe("normalized relationships are not optional", () => {
  it("needs no undefined guard on a defined capability", () => {
    const capability = defineCapability({
      name: "typed_relationships",
      description: "Declares nothing",
      execute: () => ({}),
    });

    // No `?? []` and no `?.` on either side. If these were still optional the
    // reads below would not typecheck under exactOptionalPropertyTypes.
    const requires: readonly string[] = capability.relationships.requires;
    const related: readonly string[] = capability.relationships.related;

    expect(requires).toEqual([]);
    expect(related).toEqual([]);
  });
});
