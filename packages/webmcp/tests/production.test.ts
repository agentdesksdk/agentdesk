import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/audit.ts";
import { defineCapability } from "../src/capability.ts";
import { createWebMcpClient } from "../src/client.ts";
import { toObservabilityEvent } from "../src/observability.ts";
import { riskBasedPolicy, type PolicyEngine } from "../src/policy.ts";
import { defaultValidator } from "../src/validation.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";
import type { RegisteredTool } from "../src/webmcp-adapter.ts";

describe("execution signal forwarding", () => {
  it("cancelling the client call aborts the in-flight handler", async () => {
    const model = createMockModelContext();
    let abortedDuringFlight = false;
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "slow_read",
          description: "Reads slowly",
          surface: "native",
          execute: async (_input, ctx) => {
            expect(ctx.signal).toBeInstanceOf(AbortSignal);
            expect(ctx.executionId).toMatch(/^EXE-/);
            ctx.signal.addEventListener("abort", () => {
              abortedDuringFlight = true;
              release();
            });
            entered();
            await gate;
            return "done";
          },
        }),
      ],
      exposure: "flat",
    });
    await runtime.start();

    const controller = new AbortController();
    const tool = model.tools.get("slow_read")!;
    const pending = tool.execute({}, { signal: controller.signal });

    await started;
    controller.abort();
    await pending;
    expect(abortedDuringFlight).toBe(true);
  });

  it("aborts in-flight handlers when the runtime is reset", async () => {
    const model = createMockModelContext();
    let aborted = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "long_task",
          description: "Waits",
          execute: async (_input, ctx) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
            });
            await gate;
            return "done";
          },
        }),
      ],
    });
    await runtime.start();

    const pending = runtime.invoke("long_task", {});
    await runtime.reset();
    expect(aborted).toBe(true);

    release();
    await pending;
    // A completion that lands after the epoch ended must not repopulate
    // the audit the operator just cleared.
    expect(runtime.getSnapshot().audit).toEqual([]);
  });

  it("gives each execution a correlating executionId", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "ping",
          description: "Ping",
          execute: (_input, ctx) => ctx.executionId,
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("ping", {});

    const ids = runtime
      .getSnapshot()
      .audit.filter(
        (e) => e.kind === "execution_started" || e.kind === "execution_completed",
      )
      .map((e) =>
        e.kind === "execution_started" || e.kind === "execution_completed"
          ? e.executionId
          : "",
      );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("idempotency", () => {
  it("a retry with the same key returns the first result without re-executing", async () => {
    const model = createMockModelContext();
    let runs = 0;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "charge_card",
          description: "Charges a card",
          risk: "WRITE",
          execute: () => ({ charged: ++runs }),
        }),
      ],
    });
    await runtime.start();

    const first = await model.execute("invoke_capability", {
      name: "charge_card",
      idempotency_key: "abc-123",
    });
    const second = await model.execute("invoke_capability", {
      name: "charge_card",
      idempotency_key: "abc-123",
    });
    expect(runs).toBe(1);
    expect(second).toEqual(first);

    await model.execute("invoke_capability", {
      name: "charge_card",
      idempotency_key: "different",
    });
    expect(runs).toBe(2);
  });
});

describe("schema validation", () => {
  it("rejects wrong types before the handler runs", async () => {
    const model = createMockModelContext();
    let ran = false;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "get_order",
          description: "Reads an order",
          inputSchema: {
            type: "object",
            required: ["order_id"],
            properties: {
              order_id: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 50 },
            },
          },
          execute: () => {
            ran = true;
            return "ok";
          },
        }),
      ],
    });
    await runtime.start();

    const wrongType = await runtime.invoke("get_order", { order_id: 10428 });
    expect(wrongType.code).toBe("VALIDATION_FAILED");
    expect(ran).toBe(false);

    const missing = await runtime.invoke("get_order", {});
    expect(missing.code).toBe("VALIDATION_FAILED");

    const outOfRange = await runtime.invoke("get_order", {
      order_id: "10428",
      limit: 999,
    });
    expect(outOfRange.code).toBe("VALIDATION_FAILED");

    const fractional = await runtime.invoke("get_order", {
      order_id: "10428",
      limit: 1.5,
    });
    expect(fractional.code).toBe("VALIDATION_FAILED");

    const good = await runtime.invoke("get_order", {
      order_id: "10428",
      limit: 10,
    });
    expect(good.content[0]!.text).toBe("ok");
    expect(ran).toBe(true);
  });

  it("reports every issue with a path", () => {
    const result = defaultValidator(
      {
        type: "object",
        required: ["a"],
        properties: { b: { type: "number" }, c: { enum: ["x", "y"] } },
      },
      { b: "not-a-number", c: "z" },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((i) => i.path).sort()).toEqual(["a", "b", "c"]);
    }
  });

  it("a custom validator replaces the default", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      validate: () => ({
        valid: false,
        issues: [{ path: "$", message: "always rejected" }],
      }),
      capabilities: [
        defineCapability({
          name: "anything",
          description: "Anything",
          execute: () => "ok",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("anything", {});
    expect(result.code).toBe("VALIDATION_FAILED");
    expect(result.data?.issues).toEqual([
      { path: "$", message: "always rejected" },
    ]);
  });
});

describe("pluggable policy", () => {
  it("a deny decision blocks execution with a structured reason", async () => {
    const model = createMockModelContext();
    let ran = false;
    const capPolicy: PolicyEngine = (request) => {
      const amount = request.input.amount;
      if (typeof amount === "number" && amount > 500) {
        return { kind: "deny", reason: "Refunds above $500 need a manager." };
      }
      return riskBasedPolicy(request);
    };
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      policy: capPolicy,
      capabilities: [
        defineCapability({
          name: "issue_refund",
          description: "Issues a refund",
          risk: "WRITE",
          inputSchema: {
            type: "object",
            properties: { amount: { type: "number" } },
          },
          execute: () => {
            ran = true;
            return "refunded";
          },
        }),
      ],
    });
    await runtime.start();

    const denied = await runtime.invoke("issue_refund", { amount: 900 });
    expect(denied.code).toBe("POLICY_DENIED");
    expect(denied.data?.reason).toBe("Refunds above $500 need a manager.");
    expect(ran).toBe(false);
    expect(
      runtime.getSnapshot().audit.some((e) => e.kind === "policy_denied"),
    ).toBe(true);

    const allowed = await runtime.invoke("issue_refund", { amount: 100 });
    expect(allowed.content[0]!.text).toBe("refunded");
    expect(ran).toBe(true);
  });

  it("a policy can escalate a WRITE to human approval", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      policy: () => ({ kind: "require_approval" }),
      capabilities: [
        defineCapability({
          name: "update_address",
          description: "Updates an address",
          risk: "WRITE",
          execute: () => "updated",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("update_address", {});
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(runtime.getSnapshot().pending).toHaveLength(1);
  });
});

describe("observability export", () => {
  it("streams audit events to a subscriber and maps them to a versioned envelope", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "ping",
          description: "Ping",
          execute: () => "pong",
        }),
      ],
    });
    await runtime.start();

    const seen: AuditEvent[] = [];
    const unsubscribe = runtime.subscribeAudit((event) => seen.push(event));
    await runtime.invoke("ping", {});
    unsubscribe();
    const afterUnsubscribe = seen.length;
    await runtime.invoke("ping", {});
    expect(seen.length).toBe(afterUnsubscribe);

    const completed = seen.find((e) => e.kind === "execution_completed")!;
    const exported = toObservabilityEvent(completed);
    expect(exported.schema).toBe("agentdesk.audit.v1");
    expect(exported.name).toBe("execution_completed");
    expect(exported.capability).toBe("ping");
    expect(exported.executionId).toMatch(/^EXE-/);
    expect(exported.attributes).not.toHaveProperty("kind");
  });

  it("a throwing audit subscriber cannot break execution", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "ping",
          description: "Ping",
          execute: () => "pong",
        }),
      ],
    });
    await runtime.start();
    runtime.subscribeAudit(() => {
      throw new Error("exporter down");
    });
    const result = await runtime.invoke("ping", {});
    expect(result.content[0]!.text).toBe("pong");
  });
});

describe("cross-origin exposure", () => {
  it("passes exposedTo through to registerTool", async () => {
    const calls: Array<{ name: string; exposedTo?: string[] }> = [];
    const runtime = createAgentDeskRuntime({
      registerTool: async (tool, options) => {
        const entry: { name: string; exposedTo?: string[] } = {
          name: tool.name,
        };
        if (options?.exposedTo) {
          entry.exposedTo = options.exposedTo;
        }
        calls.push(entry);
      },
      exposedTo: ["https://agent.example"],
    });
    await runtime.start();
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.exposedTo).toEqual(["https://agent.example"]);
    }
  });
});

describe("consumer client", () => {
  function fakeModelContext(overrides: Record<string, unknown>) {
    const target = new EventTarget();
    return Object.assign(target, {
      registerTool: async () => {},
      ...overrides,
    });
  }

  it("reports unsupported methods instead of throwing", async () => {
    const client = createWebMcpClient(
      fakeModelContext({}) as never,
    );
    expect(client.features.getTools).toBe(false);
    const listed = await client.listTools();
    expect(listed).toEqual({
      ok: false,
      reason: "getTools is not available in this browser",
    });
  });

  it("lists and calls tools when the browser supports them", async () => {
    const tool: RegisteredTool = {
      name: "search",
      description: "Search",
      origin: "https://shop.example",
    };
    const executeTool = vi.fn(async () => "result-text");
    const client = createWebMcpClient(
      fakeModelContext({
        getTools: async () => [tool],
        executeTool,
      }) as never,
    );
    expect(client.features.getTools).toBe(true);

    const listed = await client.listTools({
      fromOrigins: ["https://shop.example"],
    });
    expect(listed).toEqual({ ok: true, tools: [tool] });

    const called = await client.callTool(tool, { q: "desk" });
    expect(called).toEqual({ ok: true, output: "result-text" });
    expect(executeTool).toHaveBeenCalledWith(tool, '{"q":"desk"}', undefined);
  });

  it("surfaces toolchange notifications", async () => {
    const native = fakeModelContext({});
    const client = createWebMcpClient(native as never);
    let fired = 0;
    const off = client.onToolChange(() => {
      fired += 1;
    });
    native.dispatchEvent(new Event("toolchange"));
    expect(fired).toBe(1);
    off();
    native.dispatchEvent(new Event("toolchange"));
    expect(fired).toBe(1);
  });
});
