import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  nativeProvider,
  receipt,
  unavailable,
  type Actor,
  type Capability,
  type CapabilityProvider,
  type RuntimeSnapshot,
} from "../src/index.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const repoRoot = join(here, "..", "..", "..");

const AGENT: Actor = { id: "eval-agent", name: "Eval Agent", kind: "agent" };
const HUMAN: Actor = { id: "evaluator", name: "Evaluator", kind: "human" };

type CatalogModule = {
  buildCatalog: (
    define: typeof defineCapability,
    makeReceipt: typeof receipt,
    makeUnavailable: typeof unavailable,
  ) => { capabilities: Capability[] };
};

/** The demo's catalog, the one the task evaluation and the hero flow run on. */
async function demoCatalog(): Promise<Capability[]> {
  const mod = (await import(
    pathToFileURL(join(repoRoot, "scripts", "evals", "catalog.mjs")).href
  )) as CatalogModule;
  return mod.buildCatalog(defineCapability, receipt, unavailable).capabilities;
}

/** Everything a snapshot says, with the clock taken out. */
function timeless(snapshot: RuntimeSnapshot): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (["at", "createdAt", "requestedAt", "decidedAt", "executedAt", "issuedAt", "expiresAt"].includes(key)) {
          continue;
        }
        out[key] = strip(inner);
      }
      return out;
    }
    return value;
  };
  return strip(snapshot);
}

/** The hero flow: route to the order, find the refund, ask, approve. */
async function heroFlow(runtime: ReturnType<typeof createAgentDeskRuntime>, model: ReturnType<typeof createMockModelContext>) {
  await runtime.start();
  await runtime.setContext({ route: "/orders/10428", state: { orderId: "10428" } });
  await model.execute("find_capabilities", { query: "refund the shipping fee on order 10428" });
  const asked = await runtime.invoke("refund_shipping", { order_id: "10428" });
  const [pending] = runtime.getSnapshot().pending;
  const approved = pending ? await runtime.approve(pending.id, HUMAN) : undefined;
  return { asked, approved, tools: [...model.tools.keys()].sort() };
}

describe("a provider is the runtime's source of capabilities", () => {
  it("built from the native provider, the runtime is byte for byte the one built the current way", async () => {
    const catalog = await demoCatalog();
    const current = createMockModelContext();
    const viaProvider = createMockModelContext();
    const before = createAgentDeskRuntime({
      capabilities: catalog,
      registerTool: current.registerTool,
      actor: AGENT,
      exposure: "routed",
    });
    const after = createAgentDeskRuntime({
      provider: nativeProvider({ capabilities: await demoCatalog(), registerTool: viaProvider.registerTool }),
      actor: AGENT,
      exposure: "routed",
    });

    const currentRun = await heroFlow(before, current);
    const providerRun = await heroFlow(after, viaProvider);

    expect(providerRun.asked.code).toBe("APPROVAL_REQUIRED");
    expect(providerRun.approved?.isError).toBeFalsy();
    expect(providerRun.asked).toEqual(currentRun.asked);
    expect(providerRun.approved).toEqual(currentRun.approved);
    expect(providerRun.tools).toEqual(currentRun.tools);
    expect(timeless(after.getSnapshot())).toEqual(timeless(before.getSnapshot()));
    expect(after.getSnapshot().audit.map((event) => event.kind)).toEqual(
      before.getSnapshot().audit.map((event) => event.kind),
    );
    expect(after.getSnapshot().catalogSize).toBe(catalog.length);
  });

  it("refuses a provider beside the options it replaces", () => {
    expect(() =>
      createAgentDeskRuntime({
        provider: nativeProvider({ registerTool: async () => {} }),
        capabilities: [],
      }),
    ).toThrow(/provider/);
    expect(() =>
      createAgentDeskRuntime({
        provider: nativeProvider({ registerTool: async () => {} }),
        registerTool: async () => {},
      }),
    ).toThrow(/provider/);
  });

  it("reports the provider's adapter as the runtime's support", async () => {
    const runtime = createAgentDeskRuntime({ provider: nativeProvider({ registerTool: null }) });
    await runtime.start();
    expect(runtime.getSnapshot().supported).toBe(false);
  });
});

describe("the seam sits above the surface and the adapter", () => {
  const sources = () => readdirSync(srcDir).filter((name) => name.endsWith(".ts"));

  it("keeps document.modelContext inside the adapter", () => {
    const hits = sources().filter((name) => {
      const text = readFileSync(join(srcDir, name), "utf8");
      return text.includes("document?.modelContext") || text.includes("document.modelContext");
    });
    expect(hits).toEqual(["webmcp-adapter.ts"]);
  });

  it("keeps adapter.registerTool inside ToolSurfaceManager", () => {
    const hits = sources().filter((name) => {
      const text = readFileSync(join(srcDir, name), "utf8");
      return text.includes("adapter.registerTool") || text.includes("this.adapter.registerTool");
    });
    expect(hits).toEqual(["tool-surface.ts"]);
  });

  it("lets only the provider seam construct the adapter, so the runtime builds no WebMCP-specific object", () => {
    const hits = sources().filter((name) => {
      const text = readFileSync(join(srcDir, name), "utf8");
      return /(?<!function )createWebMcpAdapter\(/.test(text);
    });
    expect(hits).toEqual(["provider.ts"]);
  });
});

describe("a provider that changes its catalog after start", () => {
  function mutableProvider(initial: Capability[], registerTool: CapabilityProvider["adapter"]["registerTool"]) {
    let current = initial;
    const listeners = new Set<() => void>();
    const provider: CapabilityProvider = {
      kind: "test",
      capabilities: () => current,
      adapter: { supported: true, registerTool, features: { registerTool: true, getTools: false, executeTool: false, toolChangeEvent: false } },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      provider,
      set: (next: Capability[]) => {
        current = next;
        for (const listener of listeners) {
          listener();
        }
      },
    };
  }

  const tool = (name: string, keywords: string[]) =>
    defineCapability({ name, description: `Does ${name}`, keywords, execute: () => name });

  it("sees the tool surface reconcile: a retired capability leaves, a new one can be routed", async () => {
    const model = createMockModelContext();
    const source = mutableProvider([tool("refund_shipping", ["refund"]), tool("read_invoice", ["invoice"])], model.registerTool);
    const runtime = createAgentDeskRuntime({ provider: source.provider, exposure: "routed" });
    await runtime.start();
    await model.execute("find_capabilities", { query: "refund" });
    expect(runtime.getSnapshot().routedTools).toEqual(["refund_shipping"]);
    expect(runtime.getSnapshot().catalogSize).toBe(2);

    source.set([tool("read_invoice", ["invoice"]), tool("issue_credit", ["credit"])]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = runtime.getSnapshot();
    expect(after.catalogSize).toBe(2);
    expect(after.routedTools).toEqual([]);
    expect(after.nativeTools).not.toContain("refund_shipping");
    expect(after.available).toEqual(["issue_credit", "read_invoice"]);

    await model.execute("find_capabilities", { query: "credit" });
    expect(runtime.getSnapshot().routedTools).toEqual(["issue_credit"]);
    expect(model.tools.has("issue_credit")).toBe(true);
  });

  it("stops listening when the runtime stops", async () => {
    const model = createMockModelContext();
    const source = mutableProvider([tool("read_invoice", ["invoice"])], model.registerTool);
    const runtime = createAgentDeskRuntime({ provider: source.provider });
    await runtime.start();
    await runtime.stop();

    source.set([tool("read_invoice", ["invoice"]), tool("issue_credit", ["credit"])]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getSnapshot().catalogSize).toBe(1);
  });
});
