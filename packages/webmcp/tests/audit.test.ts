import { describe, expect, it, vi } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { createWebMcpClient } from "../src/client.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import {
  defaultValidator,
  unsupportedSchemaKeywords,
} from "../src/validation.ts";
import { createWebMcpAdapter } from "../src/webmcp-adapter.ts";
import { createMockModelContext } from "./mock-model-context.ts";
import type { RegisteredTool } from "../src/webmcp-adapter.ts";

describe("secure origin", () => {
  it("reports unsupported when document.modelContext is absent", () => {
    const adapter = createWebMcpAdapter();
    expect(adapter.supported).toBe(false);
    expect(adapter.features.registerTool).toBe(false);
  });

  it("a runtime on an insecure origin still executes in-page", async () => {
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
    const result = await runtime.invoke("ping", {});
    expect(result.content[0]!.text).toBe("pong");
  });
});

describe("idempotency guarantees", () => {
  function slowCapability(counter: { runs: number }) {
    return defineCapability({
      name: "charge_card",
      description: "Charges a card",
      risk: "WRITE",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
      },
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        counter.runs += 1;
        return { charged: counter.runs, amount: input.amount };
      },
    });
  }

  async function start(counter: { runs: number }) {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [slowCapability(counter)],
    });
    await runtime.start();
    return { model, runtime };
  }

  it("concurrent calls with the same key execute once", async () => {
    const counter = { runs: 0 };
    const { model } = await start(counter);
    const [a, b] = await Promise.all([
      model.execute("invoke_capability", {
        name: "charge_card",
        input: { amount: 10 },
        idempotency_key: "same",
      }),
      model.execute("invoke_capability", {
        name: "charge_card",
        input: { amount: 10 },
        idempotency_key: "same",
      }),
    ]);
    expect(counter.runs).toBe(1);
    expect(a).toEqual(b);
  });

  it("reusing a key with different input is rejected, not silently replayed", async () => {
    const counter = { runs: 0 };
    const { model } = await start(counter);
    await model.execute("invoke_capability", {
      name: "charge_card",
      input: { amount: 10 },
      idempotency_key: "k1",
    });
    const conflict = (await model.execute("invoke_capability", {
      name: "charge_card",
      input: { amount: 999 },
      idempotency_key: "k1",
    })) as { code?: string };
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(counter.runs).toBe(1);
  });

  it("keys are scoped per capability", async () => {
    const model = createMockModelContext();
    const runs: string[] = [];
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "alpha_write",
          description: "Alpha",
          risk: "WRITE",
          execute: () => {
            runs.push("alpha");
            return "a";
          },
        }),
        defineCapability({
          name: "bravo_write",
          description: "Bravo",
          risk: "WRITE",
          execute: () => {
            runs.push("bravo");
            return "b";
          },
        }),
      ],
    });
    await runtime.start();
    await model.execute("invoke_capability", {
      name: "alpha_write",
      idempotency_key: "shared",
    });
    await model.execute("invoke_capability", {
      name: "bravo_write",
      idempotency_key: "shared",
    });
    expect(runs).toEqual(["alpha", "bravo"]);
  });

  it("the idempotency store is bounded", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "fast_write",
          description: "Fast",
          risk: "WRITE",
          execute: () => "ok",
        }),
      ],
    });
    await runtime.start();
    for (let i = 0; i < 600; i++) {
      await model.execute("invoke_capability", {
        name: "fast_write",
        idempotency_key: `key-${i}`,
      });
    }
    expect(runtime.getSnapshot().idempotencyEntries).toBeLessThanOrEqual(512);
  });
});

describe("cancellation is caller-visible", () => {
  it("reset surfaces a cancellation result instead of a silent success", async () => {
    const model = createMockModelContext();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "long_task",
          description: "Waits",
          risk: "WRITE",
          execute: async () => {
            entered();
            await gate;
            return "completed anyway";
          },
        }),
      ],
    });
    await runtime.start();

    const pending = runtime.invoke("long_task", {});
    await started;
    await runtime.reset();
    release();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.code).toBe("EXECUTION_CANCELLED");
  });
});

describe("policy is re-evaluated at approval", () => {
  it("a policy that starts denying between request and approval blocks execution", async () => {
    const model = createMockModelContext();
    let denyNow = false;
    let ran = false;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      policy: () =>
        denyNow
          ? { kind: "deny", reason: "Refund window closed." }
          : { kind: "require_approval" },
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Refund shipping",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: () => {
            ran = true;
            return "refunded";
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    denyNow = true;
    const outcome = await runtime.approve(id);
    expect(ran).toBe(false);
    expect(outcome.code).toBe("POLICY_DENIED");
  });
});

describe("consequential actions require a working preview", () => {
  it("a declared preview that throws fails the consequential request closed", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "wipe_account",
          description: "Destroys data",
          risk: "CONSEQUENTIAL",
          previewChanges: () => {
            throw new Error("preview exploded");
          },
          execute: () => "wiped",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("wipe_account", {});
    expect(result.isError).toBe(true);
    expect(result.code).toBe("PREVIEW_UNAVAILABLE");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });

  it("a WRITE with a broken preview is unaffected", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "add_note",
          description: "Adds a note",
          risk: "WRITE",
          previewChanges: () => {
            throw new Error("preview exploded");
          },
          execute: () => "noted",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("add_note", {});
    expect(result.content[0]!.text).toBe("noted");
  });

  it("a consequential capability with no preview declared still works", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "cancel_order",
          description: "Cancels an order",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          execute: () => "cancelled",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("cancel_order", {});
    expect(result.code).toBe("APPROVAL_REQUIRED");
  });
});

describe("exposedTo origin safety", () => {
  it("rejects insecure, wildcard, and malformed origins at construction", () => {
    for (const bad of [
      "http://agent.example",
      "*",
      "https://*.example.com",
      "not a url",
      "https://agent.example/tools",
    ]) {
      expect(
        () =>
          createAgentDeskRuntime({
            registerTool: async () => {},
            exposedTo: [bad],
          }),
        `expected ${bad} to be rejected`,
      ).toThrow();
    }
  });

  it("accepts https and loopback development origins", () => {
    expect(() =>
      createAgentDeskRuntime({
        registerTool: async () => {},
        exposedTo: ["https://agent.example", "http://localhost:4178"],
      }),
    ).not.toThrow();
  });

  it("forwards accepted origins on every registration", async () => {
    const seen: Array<string[] | undefined> = [];
    const runtime = createAgentDeskRuntime({
      registerTool: async (_tool, options) => {
        seen.push(options?.exposedTo);
      },
      exposedTo: ["https://agent.example"],
    });
    await runtime.start();
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((o) => JSON.stringify(o)))).toEqual(
      new Set([JSON.stringify(["https://agent.example"])]),
    );
  });
});

describe("schema construct support", () => {
  const cases: Array<[string, Record<string, unknown>, unknown, boolean]> = [
    ["enum accepts a member", { enum: ["x", "y"] }, "x", true],
    ["enum rejects a non-member", { enum: ["x", "y"] }, "z", false],
    ["array items are checked", { type: "array", items: { type: "number" } }, [1, "two"], false],
    ["array of correct items passes", { type: "array", items: { type: "number" } }, [1, 2], true],
    ["integer rejects fractions", { type: "integer" }, 1.5, false],
    ["pattern is enforced", { type: "string", pattern: "^A" }, "B", false],
  ];

  for (const [label, property, value, shouldPass] of cases) {
    it(label, () => {
      const result = defaultValidator(
        { type: "object", properties: { field: property } },
        { field: value },
      );
      expect(result.valid).toBe(shouldPass);
    });
  }

  it("names every construct it does not enforce", () => {
    const unsupported = unsupportedSchemaKeywords({
      type: "object",
      properties: {
        a: { oneOf: [{ type: "string" }] },
        b: { anyOf: [{ type: "string" }] },
        c: { const: "fixed" },
        d: { allOf: [{ type: "string" }] },
        e: { $ref: "#/definitions/x" },
      },
      additionalProperties: false,
    } as never);
    for (const keyword of [
      "oneOf",
      "anyOf",
      "const",
      "allOf",
      "$ref",
      "additionalProperties",
    ]) {
      expect(unsupported, `${keyword} must be reported`).toContain(keyword);
    }
  });

  it("does not silently enforce a construct it cannot check", () => {
    const result = defaultValidator(
      { type: "object", properties: { choice: { const: "fixed" } } } as never,
      { choice: "anything else" },
    );
    expect(result.valid).toBe(true);
  });

  it("validates nested object properties", () => {
    const result = defaultValidator(
      {
        type: "object",
        properties: {
          order: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      { order: { id: 10428 } },
    );
    expect(result.valid).toBe(false);
  });

  it("reports nothing unsupported for a schema it fully enforces", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, n: { type: "integer" } },
      }),
    ).toEqual([]);
  });
});

describe("client cancellation, disposal, and origin filtering", () => {
  function fakeModelContext(overrides: Record<string, unknown>) {
    return Object.assign(new EventTarget(), {
      registerTool: async () => {},
      ...overrides,
    });
  }

  it("forwards an abort signal to executeTool", async () => {
    const executeTool = vi.fn(async () => "ok");
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const controller = new AbortController();
    const tool: RegisteredTool = {
      name: "t",
      description: "d",
      origin: "https://a.example",
    };
    await client.callTool(tool, {}, { signal: controller.signal });
    expect(executeTool).toHaveBeenCalledWith(tool, "{}", {
      signal: controller.signal,
    });
  });

  it("serializes input, matching what shipped Chrome accepts", async () => {
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input !== "string") {
        throw new Error("Failed to parse input arguments");
      }
      return `got ${input}`;
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const tool: RegisteredTool = {
      name: "hello",
      description: "d",
      origin: "https://a.example",
    };
    const result = await client.callTool(tool, { name: "Native" });
    expect(result).toEqual({ ok: true, output: 'got {"name":"Native"}' });
  });

  it("uses the object form for a spec-conformant implementation when configured", async () => {
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input === "string") {
        throw new Error("Failed to parse input arguments");
      }
      return "object accepted";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
      { encoding: "object" },
    );
    const tool: RegisteredTool = {
      name: "hello",
      description: "d",
      origin: "https://a.example",
    };
    const result = await client.callTool(tool, { name: "Native" });
    expect(result).toEqual({ ok: true, output: "object accepted" });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("reports an aborted call as a structured failure", async () => {
    const client = createWebMcpClient(
      fakeModelContext({
        executeTool: async (
          _t: unknown,
          _i: unknown,
          options?: { signal?: AbortSignal },
        ) =>
          new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      }) as never,
    );
    const controller = new AbortController();
    const tool: RegisteredTool = {
      name: "t",
      description: "d",
      origin: "https://a.example",
    };
    const pending = client.callTool(tool, {}, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it("passes fromOrigins through and omits it when unset", async () => {
    const getTools = vi.fn(async () => []);
    const client = createWebMcpClient(fakeModelContext({ getTools }) as never);
    await client.listTools({ fromOrigins: ["https://shop.example"] });
    expect(getTools).toHaveBeenLastCalledWith({
      fromOrigins: ["https://shop.example"],
    });
    await client.listTools();
    expect(getTools).toHaveBeenLastCalledWith();
  });

  it("disposes every toolchange listener it added", () => {
    const native = fakeModelContext({});
    const client = createWebMcpClient(native as never);
    let a = 0;
    let b = 0;
    const offA = client.onToolChange(() => {
      a += 1;
    });
    const offB = client.onToolChange(() => {
      b += 1;
    });
    native.dispatchEvent(new Event("toolchange"));
    expect([a, b]).toEqual([1, 1]);
    offA();
    native.dispatchEvent(new Event("toolchange"));
    expect([a, b]).toEqual([1, 2]);
    offB();
    native.dispatchEvent(new Event("toolchange"));
    expect([a, b]).toEqual([1, 2]);
  });
});
