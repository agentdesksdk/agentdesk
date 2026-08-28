import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const BOOTSTRAP = [
  "find_capabilities",
  "get_action_status",
  "get_context",
  "invoke_capability",
];

describe("AgentDesk runtime", () => {
  it("registers the bootstrap tools on start", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
    });
    await runtime.start();
    expect([...model.tools.keys()].sort()).toEqual(BOOTSTRAP);
    expect(runtime.getSnapshot().nativeTools).toEqual(BOOTSTRAP);
  });

  it("duplicate start() is idempotent", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
    });
    await runtime.start();
    const calls = model.registerCalls.length;
    await runtime.start();
    expect(model.registerCalls.length).toBe(calls);
  });

  it("find_capabilities lists available app capabilities through the native tool", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "hello_dynamic_tool",
          description: "A tool that appears only on the hello route",
          surface: "native",
          available: (ctx) => ctx.route === "/hello",
          execute: () => "hello",
        }),
        defineCapability({
          name: "always_on",
          description: "Always available via invoke_capability",
          execute: () => "on",
        }),
      ],
    });
    await runtime.start();
    const listed = (await model.execute("find_capabilities", {})) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(listed.content[0]!.text) as {
      catalog_size: number;
      matches: Array<{ name: string; available: boolean }>;
      activated_tools: string[];
      instruction: string;
    };
    expect(payload.catalog_size).toBe(2);
    expect(payload.matches).toEqual([
      {
        name: "always_on",
        description: "Always available via invoke_capability",
        risk: "READ",
        available: true,
        requires_approval: false,
      },
    ]);
    expect(payload.activated_tools).toEqual([]);
    expect(payload.instruction).toContain("invoke_capability");
  });

  it("registers and aborts a native tool when context changes", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "hello_dynamic_tool",
          description: "Appears on /hello",
          surface: "native",
          available: (ctx) => ctx.route === "/hello",
          execute: () => ({ ok: true }),
        }),
      ],
    });
    await runtime.start();
    expect(model.tools.has("hello_dynamic_tool")).toBe(false);

    await runtime.setContext({ route: "/hello", state: {} });
    expect(model.tools.has("hello_dynamic_tool")).toBe(true);
    const result = await model.execute("hello_dynamic_tool", {});
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });

    await runtime.setContext({ route: "/", state: {} });
    expect(runtime.getSnapshot().nativeTools).not.toContain("hello_dynamic_tool");
    expect(runtime.getSnapshot().tombstones).toContain("hello_dynamic_tool");
    expect(model.tools.has("hello_dynamic_tool")).toBe(true);
    const retired = await model.execute("hello_dynamic_tool", {});
    expect(retired).toMatchObject({
      code: "TOOL_RETIRED",
      data: { tool: "hello_dynamic_tool" },
    });
    expect(model.aborted).toContain("hello_dynamic_tool");
  });

  it("invokes a catalog capability through invoke_capability", async () => {
    const model = createMockModelContext();
    let seen: Record<string, unknown> | undefined;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "echo_box",
          description: "Echo input",
          execute: (input) => {
            seen = input;
            return { echoed: input };
          },
        }),
      ],
    });
    await runtime.start();
    const result = await model.execute("invoke_capability", {
      name: "echo_box",
      input: { q: "hi" },
    });
    expect(seen).toEqual({ q: "hi" });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ echoed: { q: "hi" } }) }],
    });
  });

  it("queues approval_required work until a human approves", async () => {
    const model = createMockModelContext();
    let applied = false;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "apply_redline",
          description: "Apply a proposed redline",
          policy: { kind: "approval_required" },
          approvalEvidence: "summary",
          execute: () => {
            applied = true;
            return "applied";
          },
        }),
      ],
    });
    await runtime.start();
    const queued = await model.execute("invoke_capability", {
      name: "apply_redline",
      input: {},
    });
    expect(applied).toBe(false);
    expect(queued).toMatchObject({
      code: "APPROVAL_REQUIRED",
      data: {
        code: "APPROVAL_REQUIRED",
        capability: "apply_redline",
      },
    });
    const pending = runtime.getSnapshot().pending;
    expect(pending).toHaveLength(1);
    const actionId = pending[0]?.id;
    expect(actionId).toBeDefined();
    if (actionId === undefined) {
      throw new Error("expected pending action");
    }
    const approved = await runtime.approve(actionId);
    expect(applied).toBe(true);
    expect(approved).toEqual({
      content: [{ type: "text", text: "applied" }],
    });
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });

  it("does not unregister tools when a snapshot listener unsubscribes", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
    });
    await runtime.start();
    const callsAfterStart = model.registerCalls.length;
    const unsubscribe = runtime.subscribe(() => {});
    unsubscribe();
    expect(model.registerCalls.length).toBe(callsAfterStart);
    expect([...model.tools.keys()].sort()).toEqual(BOOTSTRAP);
  });

  it("returns TOOL_RETIRED from a native tombstone then recovers via find_capabilities", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "alpha",
          description: "Alpha",
          surface: "native",
          available: (ctx) => ctx.route === "/abc",
          execute: () => "A",
        }),
        defineCapability({
          name: "bravo",
          description: "Bravo",
          surface: "native",
          available: (ctx) => ctx.route === "/abc",
          execute: () => "B",
        }),
        defineCapability({
          name: "charlie",
          description: "Charlie",
          surface: "native",
          available: (ctx) => ctx.route === "/abc",
          execute: () => "C",
        }),
        defineCapability({
          name: "delta",
          description: "Delta",
          surface: "native",
          available: (ctx) => ctx.route === "/de",
          execute: () => "D",
        }),
        defineCapability({
          name: "echo",
          description: "Echo",
          surface: "native",
          available: (ctx) => ctx.route === "/de",
          execute: () => "E",
        }),
      ],
    });
    await runtime.start();
    await runtime.setContext({ route: "/abc", state: {} });
    expect(model.tools.has("alpha")).toBe(true);

    await runtime.setContext({ route: "/de", state: {} });
    expect(runtime.getSnapshot().tombstones).toEqual(["alpha", "bravo", "charlie"]);
    expect(model.tools.has("alpha")).toBe(true);
    expect(model.tools.has("delta")).toBe(true);

    const stale = await model.execute("alpha", {});
    expect(stale).toMatchObject({
      code: "TOOL_RETIRED",
      data: { code: "TOOL_RETIRED", tool: "alpha" },
    });

    await model.execute("find_capabilities", {});
    expect(runtime.getSnapshot().tombstones).toEqual([]);
    expect(model.tools.has("alpha")).toBe(false);
    expect(model.tools.has("delta")).toBe(true);
  });

  it("still executes in-page when WebMCP is unsupported", async () => {
    const runtime = createAgentDeskRuntime({
      registerTool: null,
      capabilities: [
        defineCapability({
          name: "ping",
          description: "Ping",
          execute: () => "pong",
        }),
      ],
    });
    await runtime.start();
    expect(runtime.getSnapshot().supported).toBe(false);
    expect(runtime.getSnapshot().nativeTools).toEqual([]);
    const result = await runtime.invoke("ping");
    expect(result).toEqual({
      content: [{ type: "text", text: "pong" }],
    });
  });
});

describe("registration boundary", () => {
  it("keeps document.modelContext.registerTool inside the adapter", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const files = readdirSync(srcDir).filter((name: string) => name.endsWith(".ts"));
    const hits: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(srcDir, name), "utf8");
      if (text.includes("document?.modelContext") || text.includes("document.modelContext")) {
        hits.push(name);
      }
    }
    expect(hits).toEqual(["webmcp-adapter.ts"]);
  });

  it("keeps adapter.registerTool calls inside ToolSurfaceManager", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const files = readdirSync(srcDir).filter((name: string) => name.endsWith(".ts"));
    const hits: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(srcDir, name), "utf8");
      if (text.includes("adapter.registerTool") || text.includes("this.adapter.registerTool")) {
        hits.push(name);
      }
    }
    expect(hits).toEqual(["tool-surface.ts"]);
  });
});
