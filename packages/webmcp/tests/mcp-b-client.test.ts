// @vitest-environment jsdom
import {
  cleanupWebMCPPolyfill,
  initializeWebMCPPolyfill,
} from "@mcp-b/webmcp-polyfill";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWebMcpClient,
  getModelContext,
  readInputSchema,
  type ModelContextLike,
  type RegisteredTool,
} from "../src/index.ts";

const SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" } },
  required: ["subject"],
};

const modelContext = () => getModelContext()!;

async function registerProbe(): Promise<void> {
  await modelContext().registerTool({
    name: "read_order",
    description: "Reads an order.",
    inputSchema: SCHEMA,
    annotations: { readOnlyHint: true },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as never);
}

/**
 * The generation of Chrome that returns `inputSchema` as a serialized JSON
 * string. webmcp#241 replaced it with an object from 154 onward, and the
 * MCP-B types keep both arms because 149 through 153 and 154's same-document
 * tools are still in the field. The polyfill only produces the object arm,
 * so the string arm is emulated over the same registrations rather than
 * invented.
 */
function serializedSchemaContext(): ModelContextLike {
  const native = modelContext();
  return new Proxy(native, {
    get(target, key, receiver) {
      if (key !== "getTools") {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (options?: { fromOrigins?: string[] }) => {
        const tools = await target.getTools!(options);
        return tools.map((tool) => ({
          ...tool,
          inputSchema:
            tool.inputSchema === undefined
              ? undefined
              : JSON.stringify(tool.inputSchema),
        }));
      };
    },
  }) as ModelContextLike;
}

describe("reading a registered tool's input schema", () => {
  beforeEach(() => {
    initializeWebMCPPolyfill();
  });

  afterEach(() => {
    cleanupWebMCPPolyfill();
  });

  it("reads the object arm the polyfill produces", async () => {
    await registerProbe();
    const client = createWebMcpClient(modelContext());

    const listed = await client.listTools();
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    const tool = listed.tools.find((entry) => entry.name === "read_order")!;

    expect(typeof tool.inputSchema).toBe("object");
    expect(readInputSchema(tool)).toEqual({ ok: true, schema: SCHEMA });
  });

  it("reads the serialized string arm older Chrome returns", async () => {
    await registerProbe();
    const client = createWebMcpClient(serializedSchemaContext());

    const listed = await client.listTools();
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    const tool = listed.tools.find((entry) => entry.name === "read_order")!;

    expect(typeof tool.inputSchema).toBe("string");
    expect(readInputSchema(tool)).toEqual({ ok: true, schema: SCHEMA });
  });

  it("reports a schema string that is not JSON instead of throwing", () => {
    const result = readInputSchema({
      name: "read_order",
      inputSchema: "{ not json",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected the malformed schema to be refused");
    }
    expect(result.reason).toContain("read_order");
  });

  it("reports a schema string that parses to something other than an object", () => {
    const result = readInputSchema({
      name: "read_order",
      inputSchema: "[1, 2, 3]",
    });

    expect(result.ok).toBe(false);
  });

  it("treats an absent schema as absent rather than as a failure", () => {
    expect(readInputSchema({ name: "no_args" })).toEqual({
      ok: true,
      schema: undefined,
    });
  });
});

describe("calling a tool through the MCP-B polyfill", () => {
  beforeEach(() => {
    initializeWebMCPPolyfill();
  });

  afterEach(() => {
    cleanupWebMCPPolyfill();
  });

  it("defaults to the serialized encoding the Chromium extension expects", async () => {
    await registerProbe();
    const client = createWebMcpClient(modelContext());

    expect(client.encoding).toBe("string");
    const listed = await client.listTools();
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    const called = await client.callTool(
      listed.tools.find((entry) => entry.name === "read_order")!,
      { subject: "10428" },
    );

    expect(called.ok).toBe(true);
  });

  it("carries a null output through rather than typing it as a string", async () => {
    const empty: ModelContextLike = new Proxy(modelContext(), {
      get(target, key, receiver) {
        if (key === "executeTool") {
          return async () => null;
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ModelContextLike;
    const client = createWebMcpClient(empty);

    const called = await client.callTool(
      { name: "read_order", description: "", origin: "https://example.test" },
      {},
    );

    // Chromium's executeTool resolves null when a tool produces no textual
    // output, so a caller has to be handed null rather than a lie.
    expect(called).toEqual({ ok: true, output: null });
  });

  it("reports the toolchange event the polyfill dispatches", async () => {
    const client = createWebMcpClient(modelContext());
    let changes = 0;
    const stop = client.onToolChange(() => {
      changes += 1;
    });

    await registerProbe();

    expect(changes).toBeGreaterThan(0);
    stop();
  });

  it("resolves from document.modelContext alone, never the deprecated navigator alias", () => {
    const navigated = navigator as Navigator & { modelContext?: unknown };
    // The polyfill installs both. The MCP-B types deprecate the navigator
    // member, and AgentDesk must not be reading it.
    expect(navigated.modelContext).toBeDefined();
    expect(createWebMcpClient().features.registerTool).toBe(true);

    cleanupWebMCPPolyfill();
    Object.defineProperty(navigator, "modelContext", {
      value: { registerTool: async () => {} },
      configurable: true,
    });
    try {
      // Only the navigator alias is present now. A client that read it would
      // report the surface as available.
      expect(getModelContext()).toBeUndefined();
      expect(createWebMcpClient().features.registerTool).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "modelContext");
    }
  });
});

describe("a tool title is not a nullish fallback", () => {
  beforeEach(() => {
    initializeWebMCPPolyfill();
  });

  afterEach(() => {
    cleanupWebMCPPolyfill();
  });

  it("defaults to the empty string, which does not fall through `??`", async () => {
    await registerProbe();
    const [tool] = await modelContext().getTools!();
    if (!tool) {
      throw new Error("the polyfill registered no tool");
    }

    const registered = tool as RegisteredTool;
    expect(registered.title).toBe("");
    expect(registered.title ?? registered.name).toBe("");
    expect(registered.title || registered.name).toBe("read_order");
  });
});
