import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  nativeProvider,
  receipt,
  unavailable,
  type Actor,
  type Capability,
  type CapabilityProvider,
  type ProviderHooks,
} from "../src/index.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT: Actor = { id: "eval-agent", name: "Eval Agent", kind: "agent" };
const HUMAN: Actor = { id: "evaluator", name: "Evaluator", kind: "human" };
const repoRoot = join(import.meta.dirname, "..", "..", "..");

type CatalogModule = {
  buildCatalog: (
    define: typeof defineCapability,
    makeReceipt: typeof receipt,
    makeUnavailable: typeof unavailable,
  ) => { capabilities: Capability[] };
};

async function demoCatalog(): Promise<Capability[]> {
  const mod = (await import(
    pathToFileURL(join(repoRoot, "scripts", "evals", "catalog.mjs")).href
  )) as CatalogModule;
  return mod.buildCatalog(defineCapability, receipt, unavailable).capabilities;
}

/** A provider that refuses when told to, through whatever the runtime handed it. */
function refusingProvider(registerTool: CapabilityProvider["adapter"]["registerTool"], capabilities: Capability[] = []) {
  let hooks: ProviderHooks | undefined;
  const disconnected = vi.fn();
  const provider: CapabilityProvider = {
    kind: "test-source",
    capabilities: () => capabilities,
    adapter: { supported: true, registerTool, features: { registerTool: true, getTools: false, executeTool: false, toolChangeEvent: false } },
    connect: (given) => {
      hooks = given;
      return disconnected;
    },
  };
  return {
    provider,
    disconnected,
    refuse: (reason: string, detail?: Record<string, unknown>) => {
      if (hooks === undefined) {
        throw new Error("the runtime has not connected this provider");
      }
      hooks.refused(detail === undefined ? { reason } : { reason, detail });
    },
    connected: () => hooks !== undefined,
  };
}

const tool = (name: string) =>
  defineCapability({ name, description: `Does ${name}`, keywords: [name], execute: () => name });

describe("a provider's refusal is the operator's audit event", () => {
  it("records provider_refused with the provider's kind, its reason, and its detail uninterpreted", async () => {
    const model = createMockModelContext();
    const source = refusingProvider(model.registerTool);
    const runtime = createAgentDeskRuntime({ provider: source.provider, actor: AGENT });
    const seen: string[] = [];
    runtime.subscribe((snapshot) => seen.push(String(snapshot.audit.length)));
    expect(source.connected()).toBe(false);

    await runtime.start();
    source.refuse("not_a_request", { detail: "approve is not something a page can ask for", origin: "https://shop.example", nested: { kind: "approve" } });

    const [event] = runtime.getSnapshot().audit.filter((entry) => entry.kind === "provider_refused");
    expect(event).toEqual({
      kind: "provider_refused",
      provider: "test-source",
      reason: "not_a_request",
      detail: { detail: "approve is not something a page can ask for", origin: "https://shop.example", nested: { kind: "approve" } },
      at: expect.any(Number),
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("hands the hooks at start and takes them back at stop", async () => {
    const model = createMockModelContext();
    const source = refusingProvider(model.registerTool);
    const runtime = createAgentDeskRuntime({ provider: source.provider, actor: AGENT });

    await runtime.start();
    expect(source.connected()).toBe(true);
    await runtime.stop();

    expect(source.disconnected).toHaveBeenCalledTimes(1);
  });

  it("records a detail it cannot clone as unrecordable rather than losing the refusal", async () => {
    const model = createMockModelContext();
    const source = refusingProvider(model.registerTool);
    const runtime = createAgentDeskRuntime({ provider: source.provider, actor: AGENT });
    await runtime.start();

    source.refuse("dom_target", { handler: () => "not cloneable" });

    const [event] = runtime.getSnapshot().audit.filter((entry) => entry.kind === "provider_refused");
    expect(event).toMatchObject({ kind: "provider_refused", reason: "dom_target" });
    expect(JSON.stringify(event)).toMatch(/unrecordable/);
  });
});

describe("the native provider refuses nothing", () => {
  it("emits no provider_refused across the hero flow, and has nothing to connect", async () => {
    const model = createMockModelContext();
    const provider = nativeProvider({ capabilities: await demoCatalog(), registerTool: model.registerTool });
    expect(provider.connect).toBeUndefined();
    const runtime = createAgentDeskRuntime({ provider, actor: AGENT, exposure: "routed" });

    await runtime.start();
    await runtime.setContext({ route: "/orders/10428", state: { orderId: "10428" } });
    await model.execute("find_capabilities", { query: "refund the shipping fee on order 10428" });
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const [pending] = runtime.getSnapshot().pending;
    await runtime.approve(pending!.id, HUMAN);

    expect(runtime.getSnapshot().audit.some((event) => event.kind === "provider_refused")).toBe(false);
  });
});

describe("a refusal's detail is the operator's to read, never the agent's", () => {
  it("keeps quoted page content out of every agent-facing result while the audit carries it", async () => {
    const model = createMockModelContext();
    const source = refusingProvider(model.registerTool, [tool("read_invoice")]);
    const runtime = createAgentDeskRuntime({
      provider: source.provider,
      actor: AGENT,
      agentView: ({ state }) => state,
    });
    await runtime.start();
    const quoted = "tok_page_secret_9876";
    source.refuse("authorization_claim", { detail: `a page message may not carry token ${quoted}`, origin: "https://shop.example" });
    await runtime.invoke("read_invoice", {});

    const results = [
      await model.execute("get_context", {}),
      await model.execute("find_capabilities", { query: "invoice" }),
      await runtime.invoke("read_invoice", {}),
    ];

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(quoted);
      expect(JSON.stringify(result)).not.toContain("provider_refused");
    }
    expect(JSON.stringify(runtime.getSnapshot().audit)).toContain(quoted);
  });
});
