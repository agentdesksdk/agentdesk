import { describe, expect, it, vi } from "vitest";
import { createWebMcpClient } from "../src/client.ts";
import {
  defaultValidator,
  unsupportedSchemaKeywords,
} from "../src/validation.ts";
import type { RegisteredTool } from "../src/webmcp-adapter.ts";

function fakeModelContext(overrides: Record<string, unknown>) {
  return Object.assign(new EventTarget(), {
    registerTool: async () => {},
    ...overrides,
  });
}

const tool: RegisteredTool = {
  name: "refund_shipping",
  description: "Refunds shipping",
  origin: "https://shop.example",
};

describe("callTool never executes a write twice", () => {
  it("does not retry when the handler committed and then threw", async () => {
    let commits = 0;
    const executeTool = vi.fn(async () => {
      commits += 1;
      throw new Error("downstream ledger timeout");
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    const result = await client.callTool(tool, { order_id: "10428" });
    expect(commits).toBe(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("does not report a retried failure as success", async () => {
    let calls = 0;
    const executeTool = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("handler exploded after committing");
      }
      return "second call succeeded";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    const result = await client.callTool(tool, {});
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("retries only after a pre-execution argument-format rejection", async () => {
    let handlerRuns = 0;
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input === "string") {
        throw new Error("Failed to parse input arguments");
      }
      handlerRuns += 1;
      return "object accepted";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    const result = await client.callTool(tool, { order_id: "10428" });
    expect(result).toEqual({ ok: true, output: "object accepted" });
    expect(handlerRuns).toBe(1);
  });

  it("learns the encoding once and stops probing", async () => {
    const seen: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      seen.push(input);
      if (typeof input === "string") {
        throw new Error("Failed to parse input arguments");
      }
      return "ok";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    await client.callTool(tool, { a: 1 });
    await client.callTool(tool, { b: 2 });
    expect(seen).toEqual([`{"a":1}`, { a: 1 }, { b: 2 }]);
  });

  it("remembers that the string form works and never sends an object", async () => {
    const seen: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      seen.push(input);
      return "ok";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    await client.callTool(tool, { a: 1 });
    await client.callTool(tool, { b: 2 });
    expect(seen).toEqual([`{"a":1}`, `{"b":2}`]);
  });
});

describe("callTool always returns a structured result", () => {
  it("reports a circular input instead of rejecting", async () => {
    const executeTool = vi.fn(async () => "never reached");
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await client.callTool(tool, circular);
    expect(result.ok).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("reports a BigInt input instead of rejecting", async () => {
    const executeTool = vi.fn(async () => "never reached");
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    const result = await client.callTool(tool, { amount: 10n } as never);
    expect(result.ok).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("the reporter has no remaining blind spots", () => {
  it("reports an empty type array, which would disable checking", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { v: { type: [] } },
      } as never),
    ).toContain("type");
  });

  it("reports a non-schema property value", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { v: "not-a-schema" },
      } as never),
    ).toContain("properties");
  });

  it("reports an object-valued enum it cannot compare structurally", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { v: { enum: [{ a: 1 }, { a: 2 }] } },
      } as never),
    ).toContain("enum");
  });

  it("does not falsely reject a structurally equal object against an object enum", () => {
    const result = defaultValidator(
      { type: "object", properties: { v: { enum: [{ a: 1 }] } } } as never,
      { v: { a: 1 } },
    );
    expect(result.valid).toBe(true);
  });

  it("still enforces a primitive enum", () => {
    const schema = {
      type: "object" as const,
      properties: { v: { enum: ["x", "y"] } },
    };
    expect(defaultValidator(schema, { v: "x" }).valid).toBe(true);
    expect(defaultValidator(schema, { v: "z" }).valid).toBe(false);
  });
});
