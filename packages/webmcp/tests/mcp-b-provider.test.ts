// @vitest-environment jsdom
import {
  cleanupWebMCPPolyfill,
  initializeWebMCPPolyfill,
} from "@mcp-b/webmcp-polyfill";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AVAILABLE,
  createAgentDeskRuntime,
  defineCapability,
  getModelContext,
  probeFeatures,
  type Capability,
} from "../src/index.ts";

/**
 * AgentDesk driven against MCP-B's polyfill rather than a hand-written
 * double, so registration, retirement, `toolchange`, and abort are checked
 * against behaviour an adopter's browser will actually have. The polyfill
 * installs `document.modelContext`; nothing here reads
 * `navigator.modelContext`, which the MCP-B types mark deprecated.
 */
function tool(
  name: string,
  topic: string,
  execute: (input: object, ctx: { signal: AbortSignal }) => unknown = () => ({
    ok: true,
  }),
): Capability {
  return defineCapability({
    name,
    description: `Reads ${topic} detail for ${name}.`,
    risk: "READ",
    keywords: [topic],
    intents: [`${topic} ${name}`],
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string" } },
    },
    availability: () => AVAILABLE,
    execute,
  });
}

/**
 * More capabilities than the routing budget of six, split across two topics,
 * so a routed working set genuinely excludes some and retirement is
 * observable rather than vacuous.
 */
function catalog(
  overrides: Record<
    string,
    (input: object, ctx: { signal: AbortSignal }) => unknown
  > = {},
): Capability[] {
  const built: Capability[] = [];
  for (const topic of ["orders", "tickets"]) {
    for (let i = 0; i < 5; i += 1) {
      const name = `${topic}_read_${i}`;
      built.push(tool(name, topic, overrides[name]));
    }
  }
  return built;
}

const modelContext = () => getModelContext()!;

const names = async () =>
  (await modelContext().getTools!()).map((registered) => registered.name).sort();

const startRuntime = (capabilities: Capability[]) =>
  createAgentDeskRuntime({ capabilities });

describe("AgentDesk against the MCP-B polyfill", () => {
  beforeEach(() => {
    initializeWebMCPPolyfill();
  });

  afterEach(() => {
    cleanupWebMCPPolyfill();
  });

  it("finds every method it probes for on document.modelContext", () => {
    expect(probeFeatures()).toEqual({
      registerTool: true,
      getTools: true,
      executeTool: true,
      toolChangeEvent: true,
    });
  });

  it("registers its bootstrap surface where getTools can see it", async () => {
    const runtime = startRuntime(catalog());
    await runtime.start();

    const registered = await names();
    for (const bootstrap of [
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]) {
      expect(registered).toContain(bootstrap);
    }
    // Nothing but the bootstrap surface until a task routes. Ten
    // capabilities are in the catalog and none of them is on the wire.
    expect(registered).toHaveLength(4);
  });

  it("fires toolchange when routing changes the surface", async () => {
    const runtime = startRuntime(catalog());
    await runtime.start();
    await runtime.routeTask("orders");
    let changes = 0;
    modelContext().addEventListener("toolchange", () => {
      changes += 1;
    });

    await runtime.routeTask("tickets");

    expect(changes).toBeGreaterThan(0);
    expect(await names()).toContain("tickets_read_0");
  });

  it("retires a routed tool when the working set moves on", async () => {
    const runtime = startRuntime(catalog());
    await runtime.start();
    await runtime.routeTask("orders");
    expect(await names()).toContain("orders_read_0");

    await runtime.routeTask("tickets");

    // The name stays registered on purpose. A retired tool is replaced by a
    // tombstone so a client holding a stale list gets a structured
    // TOOL_RETIRED rather than an unknown-tool error.
    const snapshot = runtime.getSnapshot();
    expect(snapshot.routedTools).toContain("tickets_read_0");
    expect(snapshot.routedTools).not.toContain("orders_read_0");
    expect(snapshot.tombstones).toContain("orders_read_0");
    expect(await names()).toContain("orders_read_0");
  });

  it("answers a stale call through the tombstone rather than the handler", async () => {
    let ran = 0;
    const runtime = startRuntime(
      catalog({
        orders_read_0: () => {
          ran += 1;
          return { ok: true };
        },
      }),
    );
    await runtime.start();
    await runtime.routeTask("orders");
    // A client that cached the tool list still holds this descriptor.
    const stale = (await modelContext().getTools!()).find(
      (registered) => registered.name === "orders_read_0",
    )!;
    await runtime.routeTask("tickets");

    const output = await modelContext().executeTool!(stale, "{}");

    expect(ran).toBe(0);
    expect(String(output)).toContain("TOOL_RETIRED");
  });

  it("hands the handler a live signal even though the polyfill passes no options", async () => {
    let observed: { present: boolean; aborted: boolean } | undefined;
    const runtime = startRuntime([
      ...catalog(),
      tool("orders_slow_read", "orders", (_input, ctx) => {
        observed = {
          present: typeof ctx.signal?.aborted === "boolean",
          aborted: ctx.signal.aborted,
        };
        return { ok: true };
      }),
    ]);
    await runtime.start();
    await runtime.routeTask("orders slow read");
    const registered = (await modelContext().getTools!()).find(
      (candidate) => candidate.name === "orders_slow_read",
    )!;

    await modelContext().executeTool!(registered, "{}");

    // MCP-B's polyfill calls `execute(input)` with no options argument, so
    // there is no caller signal to forward. The runtime still supplies one
    // tied to its own lifecycle rather than handing the handler undefined.
    expect(observed).toEqual({ present: true, aborted: false });
  });

  it("aborts an in-flight handler when the runtime stops", async () => {
    let abortedDuringRun: boolean | undefined;
    let announceStart: (() => void) | undefined;
    let letFinish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      letFinish = resolve;
    });
    const runtime = startRuntime([
      ...catalog(),
      tool("orders_slow_read", "orders", async (_input, ctx) => {
        announceStart?.();
        await finish;
        abortedDuringRun = ctx.signal.aborted;
        return { ok: true };
      }),
    ]);
    await runtime.start();
    await runtime.routeTask("orders slow read");
    const registered = (await modelContext().getTools!()).find(
      (candidate) => candidate.name === "orders_slow_read",
    )!;

    const call = modelContext().executeTool!(registered, "{}");
    await started;
    await runtime.stop();
    letFinish?.();
    await call.catch(() => undefined);
    await finish;

    expect(abortedDuringRun).toBe(true);
  });

  it("survives the model context disappearing under it", async () => {
    const runtime = startRuntime(catalog());
    await runtime.start();
    await runtime.routeTask("orders");

    // What a navigation looks like from the page's side: the context the
    // runtime registered into is simply gone.
    cleanupWebMCPPolyfill();

    expect(getModelContext()).toBeUndefined();
    expect(probeFeatures()).toEqual({
      registerTool: false,
      getTools: false,
      executeTool: false,
      toolChangeEvent: false,
    });
    // The runtime keeps answering, because its own state does not live in
    // the browser surface it registered into.
    const result = await runtime.invoke("orders_read_0", { subject: "10428" });
    expect(result.isError).not.toBe(true);
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("re-registers into the context a fresh document installs", async () => {
    const runtime = startRuntime(catalog());
    await runtime.start();
    cleanupWebMCPPolyfill();
    await runtime.stop();

    initializeWebMCPPolyfill();
    const next = startRuntime(catalog());
    await next.start();

    expect(await names()).toContain("find_capabilities");
  });
});
