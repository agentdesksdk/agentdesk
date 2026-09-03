import { describe, expect, it } from "vitest";
import {
  catalogHierarchy,
  createAgentDeskRuntime,
  defineCapability,
  hierarchicalScorer,
  hierarchicalScorerWith,
  NEAR_TIE,
  rankCapabilities,
  routeTask,
  type Capability,
} from "../src/index.ts";
import { MAX_ROUTED } from "../src/router.ts";
import { createMockModelContext } from "./mock-model-context.ts";

/**
 * The shape the routing stress catalog generates: a verb with two spoken
 * synonyms, an object with single-word synonyms, intents from the verb and
 * the object, keywords from every synonym. Vocabulary is shared across
 * domains on purpose, because that is what collides.
 */
const VERBS: Record<string, { syn: [string, string]; describe: string; risk?: "READ" | "WRITE" | "CONSEQUENTIAL" }> = {
  list: { syn: ["show", "browse"], describe: "List {os} matching a filter, newest first.", risk: "READ" },
  find: { syn: ["look up", "search"], describe: "Find a {o} by id or by free text.", risk: "READ" },
  get: { syn: ["open", "view"], describe: "Fetch one {o} with every field and its history.", risk: "READ" },
  export: { syn: ["download", "pull"], describe: "Export {os} as a CSV file for the finance team.", risk: "READ" },
  create: { syn: ["add", "raise"], describe: "Create a new {o} from the fields supplied.", risk: "WRITE" },
  update: { syn: ["edit", "change"], describe: "Change fields on an existing {o}.", risk: "WRITE" },
  merge: { syn: ["combine", "dedupe"], describe: "Merge two {os} into one and keep the older id.", risk: "WRITE" },
  delete: { syn: ["remove", "purge"], describe: "Permanently delete a {o} and everything attached to it.", risk: "CONSEQUENTIAL" },
  archive: { syn: ["retire", "file away"], describe: "Archive a {o} out of the active list.", risk: "CONSEQUENTIAL" },
  refund: { syn: ["reimburse", "pay back"], describe: "Refund a {o} to the customer's original payment method.", risk: "CONSEQUENTIAL" },
};

function cap(
  domain: string,
  verb: string,
  object: string,
  synonyms: string[],
  extra: { subdomain?: string; name?: string } = {},
): Capability {
  const v = VERBS[verb]!;
  const plural = object.endsWith("s") ? object : `${object}s`;
  return defineCapability({
    name: extra.name ?? `${verb}_${object.replaceAll(" ", "_")}`,
    title: `${verb} ${object}`,
    description: `${v.describe.replaceAll("{os}", plural).replaceAll("{o}", object)} (${domain})`,
    domain,
    ...(extra.subdomain !== undefined ? { subdomain: extra.subdomain } : {}),
    intents: [`${verb} ${object}`, `${v.syn[0]} ${object}`, `${v.syn[1]} ${plural}`],
    keywords: [...new Set([...synonyms, ...v.syn.flatMap((s) => s.split(" ")), ...object.split(" ")])],
    risk: v.risk ?? "READ",
    ...(v.risk === "CONSEQUENTIAL" ? { approvalEvidence: "summary" as const } : {}),
    execute: () => `${verb} ${object} ok`,
  });
}

/** Five domains whose vocabulary collides the way the report's misses do. */
function collidingCatalog(): Capability[] {
  return [
    // customers: eleven capabilities carry the keyword "customer", the way
    // the stress catalog does, which is what the report's refund phrasing
    // routed instead of a refund.
    ...["archive", "create", "delete", "export", "find", "get", "list", "merge", "update", "refund", "list"].map(
      (verb, i) => cap("customers", verb, "customer", ["client", "buyer"], i === 10 ? { name: "list_customer_tag" } : {}),
    ),
    cap("customers", "create", "customer note", ["comment", "remark"], { subdomain: "notes" }),
    cap("customers", "find", "contact", ["person", "email"]),
    cap("customers", "create", "contact", ["person", "email"]),
    cap("customers", "merge", "contact", ["person", "email"]),
    // orders: five order-line capabilities carry "item"
    cap("orders", "list", "order line", ["item", "line"]),
    cap("orders", "get", "order line", ["item", "line"]),
    cap("orders", "create", "order line", ["item", "line"]),
    cap("orders", "update", "order line", ["item", "line"]),
    cap("orders", "delete", "order line", ["item", "line"]),
    cap("orders", "get", "order", ["purchase", "po"]),
    // billing
    cap("billing", "get", "invoice", ["bill"]),
    cap("billing", "create", "invoice", ["bill"]),
    cap("billing", "refund", "charge", ["fee", "cost"]),
    cap("billing", "refund", "shipping fee", ["postage", "freight"]),
    cap("billing", "create", "credit note", ["credit", "memo"]),
    // payments
    cap("payments", "get", "payment", ["transaction", "txn"]),
    cap("payments", "refund", "payment", ["transaction", "txn"]),
    cap("payments", "delete", "payment method", ["card", "wallet"]),
    cap("payments", "get", "receipt", ["proof", "confirmation"]),
    // invoices
    cap("invoices", "get", "invoice pdf", ["pdf", "document"]),
    cap("invoices", "create", "invoice batch", ["batch", "run"]),
    cap("invoices", "list", "invoice batch", ["batch", "run"]),
    // shipping
    cap("shipping", "get", "delivery", ["dropoff", "handover"]),
    cap("shipping", "list", "delivery", ["dropoff", "handover"]),
    cap("shipping", "get", "carrier", ["courier", "forwarder"]),
  ];
}

/** Twelve domains of thirty-four, the stress catalog's size, for the byte bound. */
function largeCatalog(): Capability[] {
  const domains = ["orders", "shipping", "billing", "invoices", "payments", "customers", "accounts", "inventory", "catalog", "returns", "support", "reports"];
  const verbs = Object.keys(VERBS);
  const out: Capability[] = [];
  for (const domain of domains) {
    for (let i = 0; i < 34; i += 1) {
      const verb = verbs[i % verbs.length]!;
      const object = `${domain} thing ${Math.floor(i / verbs.length)}`;
      out.push(cap(domain, verb, object, [`${domain}word${i % 5}`, "shared"], { name: `${verb}_${domain}_${i}` }));
    }
  }
  return out;
}

type FindPayload = {
  catalog_size: number;
  query: string;
  domain?: string;
  matches: Array<{ name: string; description: string; risk: string; available: boolean }>;
  domains?: Array<{ name: string; description: string; capabilities: number; subdomains?: Array<{ name: string; capabilities: number }> }>;
  activated_tools: string[];
  instruction: string;
};

async function booted(capabilities: Capability[], policy?: Parameters<typeof createAgentDeskRuntime>[0]["policy"]) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities,
    ...(policy ? { policy } : {}),
  });
  await runtime.start();
  const find = async (input: Record<string, unknown>): Promise<FindPayload> => {
    const result = (await model.execute("find_capabilities", input)) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as FindPayload;
  };
  return { model, runtime, find };
}

const UTF8 = new TextEncoder();

describe("the catalog tree is derived once and deterministically", () => {
  it("groups by domain, then subdomain defaulting from the domain, with counts and a derived description", () => {
    const tree = catalogHierarchy(collidingCatalog()).view(() => true);

    expect(tree.domains.map((d) => d.name)).toEqual(["billing", "customers", "invoices", "orders", "payments", "shipping"]);
    const customers = tree.domains.find((d) => d.name === "customers")!;
    expect(customers.capabilities).toBe(15);
    expect(customers.description).toMatch(/customer/);
    expect(customers.description).toMatch(/contact/);
    expect(customers.subdomains).toEqual([
      { name: "customers", capabilities: 14 },
      { name: "notes", capabilities: 1 },
    ]);
    // A domain whose members all default their subdomain lists none.
    expect(tree.domains.find((d) => d.name === "billing")!.subdomains).toBeUndefined();
    expect(tree.total).toBe(36);
  });

  it("is the same tree whatever order the catalog arrived in", () => {
    const forward = catalogHierarchy(collidingCatalog()).view(() => true);
    const backward = catalogHierarchy([...collidingCatalog()].reverse()).view(() => true);

    expect(backward).toEqual(forward);
  });

  it("is cached: the same routable set returns the same tree object, and a change returns a new one", () => {
    const hierarchy = catalogHierarchy(collidingCatalog());
    const first = hierarchy.view(() => true);
    const again = hierarchy.view(() => true);
    const narrowed = hierarchy.view((capability) => capability.name !== "delete_customer");

    expect(again).toBe(first);
    expect(narrowed).not.toBe(first);
    expect(narrowed.domains.find((d) => d.name === "customers")!.capabilities).toBe(14);
  });
});

describe("a denied capability is absent from every level", () => {
  it("is not counted, not described, and not ranked even when the query names it", async () => {
    const { find } = await booted(collidingCatalog(), ({ capability }) =>
      capability.name === "delete_customer" ? { kind: "deny", reason: "no deletes" } : { kind: "allow" },
    );

    const top = await find({ query: "" });
    const customers = top.domains!.find((d) => d.name === "customers")!;
    expect(customers.capabilities).toBe(14);
    expect(customers.description).not.toMatch(/purge/);

    const narrowed = await find({ query: "purge the customer", domain: "customers" });
    expect(narrowed.matches.map((m) => m.name)).not.toContain("delete_customer");
    expect(narrowed.matches.length).toBeGreaterThan(0);
  });
});

describe("the hierarchy lands documented routing misses without requiring a second call", () => {
  const misses: Array<{ id: string; query: string; domain: string; expected: string }> = [
    {
      id: "billing-refund-shipping",
      query: "The customer on 10428 says we charged her for delivery she never asked for, can we give that money back",
      domain: "billing",
      expected: "refund_shipping_fee",
    },
    {
      id: "payments-proof-for-expenses",
      query: "Customer needs proof of the 89.00 they paid on the 3rd for their expenses",
      domain: "payments",
      expected: "get_receipt",
    },
    {
      id: "invoices-month-end-run",
      query: "Run the end-of-month invoicing for all subscription customers",
      domain: "invoices",
      expected: "create_invoice_batch",
    },
    {
      id: "payments-partial-back",
      query: "Send 15.00 back to the card on 55610 for the missing item",
      domain: "payments",
      expected: "refund_payment",
    },
  ];

  for (const miss of misses) {
    it(`${miss.id}: the autonomous and explicit-domain paths both land ${miss.expected}`, async () => {
      const { find } = await booted(collidingCatalog());

      const single = await find({ query: miss.query });
      const narrowed = await find({ query: miss.query, domain: miss.domain });

      expect(single.matches.map((m) => m.name)).toContain(miss.expected);
      expect(narrowed.matches.map((m) => m.name)).toContain(miss.expected);
      expect(narrowed.domain).toBe(miss.domain);
      for (const match of narrowed.matches) {
        expect(match.description).toMatch(new RegExp(`\\(${miss.domain}\\)$`));
      }
    });
  }

  it("narrows to a subdomain named as domain/subdomain", async () => {
    const { find } = await booted(collidingCatalog());

    const notes = await find({ query: "add a note", domain: "customers/notes" });

    expect(notes.matches.map((m) => m.name)).toEqual(["create_customer_note"]);
    expect(notes.domain).toBe("customers/notes");
  });
});

describe("the single-call path uses the hierarchy autonomously", () => {
  it("adds the domain tree beside automatically narrowed matches", async () => {
    const { find, runtime } = await booted(collidingCatalog());
    const query = "The customer on 10428 says we charged her for delivery she never asked for, can we give that money back";

    const payload = await find({ query });

    expect(payload.matches.map((m) => m.name)).toContain("refund_shipping_fee");
    expect(payload.matches.every((match) => match.description.endsWith("(billing)"))).toBe(true);
    expect(payload.domain).toBeUndefined();
    const names = ["billing", "customers", "invoices", "orders", "payments", "shipping"];
    expect(payload.domains!.map((d) => d.name)).toEqual(names);
    expect(payload.instruction).toMatch(/domain/);
    expect(runtime.getSnapshot().lastRouting?.domains?.map((d) => d.name)).toEqual(names);
  });

  it("answers an unknown domain with the tree and nothing routed", async () => {
    const { find, model } = await booted(collidingCatalog());

    const payload = await find({ query: "refund", domain: "warehouses" });

    expect(payload.matches).toEqual([]);
    expect(payload.domains!.length).toBe(6);
    expect(payload.instruction).toMatch(/warehouses/);
    expect(model.tools.size).toBeLessThanOrEqual(4 + MAX_ROUTED);
  });
});

describe("the budget holds on every path", () => {
  it("never holds more than the bootstrap tools plus MAX_ROUTED live, on any path", async () => {
    const { find, model, runtime } = await booted(largeCatalog());

    for (const input of [
      { query: "shared thing" },
      { query: "shared thing", domain: "orders" },
      { query: "shared thing", domain: "orders/orders" },
      { query: "", domain: "billing" },
      { query: "shared thing", domain: "nowhere" },
    ]) {
      await find(input);
      // A tool retired by this call stays registered as a tombstone until
      // the next call clears it, so the live set is what is counted.
      const snapshot = runtime.getSnapshot();
      const live = snapshot.nativeTools.filter((name) => !snapshot.tombstones.includes(name));
      expect(live.length).toBeLessThanOrEqual(4 + MAX_ROUTED);
      expect(snapshot.routedTools.length).toBeLessThanOrEqual(MAX_ROUTED);
      expect(model.tools.size - snapshot.tombstones.length).toBeLessThanOrEqual(4 + MAX_ROUTED);
    }
  });

  it("keeps the first-level tree below the bootstrap surface's own schema bytes", async () => {
    const { find, runtime } = await booted(largeCatalog());
    const bootstrapBytes = runtime.getSnapshot().schemaBytes;

    const payload = await find({ query: "" });

    expect(payload.domains!.length).toBe(12);
    const treeBytes = UTF8.encode(JSON.stringify(payload.domains)).length;
    expect(treeBytes).toBeGreaterThan(0);
    expect(treeBytes).toBeLessThan(bootstrapBytes);
  });
});

describe("the hierarchical scorer narrows by domain before it ranks", () => {
  const context = { route: "/", state: {} };

  it("routes into the domain the query's decisive tokens name", async () => {
    const result = await routeTask(
      collidingCatalog(),
      { query: "Customer needs proof of the 89.00 they paid on the 3rd for their expenses", context, limit: 6 },
      { kind: "custom", scorer: hierarchicalScorer, onFailure: "refuse" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const names = result.matches.map((m) => m.capability.name);
    expect(names[0]).toBe("get_receipt");
    for (const match of result.matches) {
      expect(match.capability.domain).toBe("payments");
    }
  });

  it("falls back to the deterministic ranking when no domain is named or implied", async () => {
    const catalog = collidingCatalog();
    const query = "do the usual thing";
    const custom = await routeTask(catalog, { query, context, limit: 6 }, { kind: "custom", scorer: hierarchicalScorer, onFailure: "refuse" });
    const plain = await routeTask(catalog, { query, context, limit: 6 });

    expect(custom.ok && plain.ok).toBe(true);
    if (!custom.ok || !plain.ok) {
      return;
    }
    expect(custom.matches.map((m) => m.capability.name)).toEqual(plain.matches.map((m) => m.capability.name));
  });

  it("reduces a tie at the cut by what the query shares with the description, before the name", async () => {
    const tied = [
      cap("support", "archive", "ticket", ["case", "conversation"]),
      cap("support", "merge", "ticket", ["case", "conversation"]),
    ];
    const result = await routeTask(
      tied,
      { query: "Maria opened three cases about the same hoodie, fold them into one", context, limit: 6 },
      { kind: "custom", scorer: hierarchicalScorer, onFailure: "refuse" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.matches.map((m) => m.capability.name)).toEqual(["merge_ticket", "archive_ticket"]);
    expect(result.matches[0]!.score).toBeGreaterThan(result.matches[1]!.score);
  });
});

describe("the domain step keeps one domain unless a second ties it exactly", () => {
  const context = { route: "/", state: {} };
  /**
   * Twelve capabilities so the weights land where the fixture needs them:
   * "alpha" is borne by one capability in alpha, "beta" by two in beta,
   * "gamma" by one in gamma, and the rest carry nothing the queries say.
   * With inverse capability frequency, "alpha beta" scores alpha at
   * log(13) and beta at log(7), a ratio just over 0.75 and under 1.0;
   * "alpha gamma" scores alpha and gamma equal.
   */
  const nearTied = (): Capability[] => [
    cap("alpha", "get", "alpha thing", ["alpha"]),
    cap("beta", "get", "beta thing", ["beta"]),
    cap("beta", "list", "beta thing", ["beta"]),
    cap("gamma", "get", "gamma thing", ["gamma"]),
    ...Array.from({ length: 8 }, (_, i) => cap("delta", "get", `delta thing ${i}`, ["delta"], { name: `get_delta_${i}` })),
  ];
  const names = async (scorer: typeof hierarchicalScorer, query: string) => {
    const result = await routeTask(nearTied(), { query, context, limit: 6 }, { kind: "custom", scorer, onFailure: "refuse" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.matches.map((m) => m.capability.name).sort();
  };

  it("ships with the near-tie at 1.0, so only an exact tie keeps a second domain", async () => {
    expect(NEAR_TIE).toBe(1);
    expect(await names(hierarchicalScorer, "alpha beta")).toEqual(["get_alpha_thing"]);
    expect(await names(hierarchicalScorer, "alpha gamma")).toEqual(["get_alpha_thing", "get_gamma_thing"]);
  });

  it("keeps a nearly tied second domain when asked to, as the first measurement did", async () => {
    const lenient = hierarchicalScorerWith({ nearTie: 0.75 });
    expect(await names(lenient, "alpha beta")).toEqual(["get_alpha_thing", "get_beta_thing", "list_beta_thing"]);
    expect(await names(hierarchicalScorerWith({ nearTie: 1 }), "alpha beta")).toEqual(["get_alpha_thing"]);
  });

  it("refuses a near-tie outside (0, 1]", () => {
    expect(() => hierarchicalScorerWith({ nearTie: 0 })).toThrow(/nearTie/);
    expect(() => hierarchicalScorerWith({ nearTie: 1.5 })).toThrow(/nearTie/);
  });
});
