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

describe("a committed handler that throws is never re-invoked", () => {
  for (const message of [
    "invalid input argument: order id was rejected after the audit write",
    "Failed to parse input arguments after commit",
  ]) {
    it(`records one invocation for: ${message.slice(0, 34)}…`, async () => {
      let commits = 0;
      const executeTool = vi.fn(async () => {
        commits += 1;
        throw new Error(message);
      });
      const client = createWebMcpClient(
        fakeModelContext({ executeTool }) as never,
      );

      const result = await client.callTool(tool, { order_id: "10428" });
      expect(commits).toBe(1);
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
    });
  }
});

describe("encoding is chosen before the call, not negotiated by retrying", () => {
  it("defaults to the string form that shipped Chrome requires", async () => {
    const seen: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      seen.push(input);
      return "ok";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    await client.callTool(tool, { a: 1 });
    expect(seen).toEqual([`{"a":1}`]);
    expect(client.encoding).toBe("string");
  });

  it("honours an explicit object encoding", async () => {
    const seen: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      seen.push(input);
      return "ok";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
      { encoding: "object" },
    );
    await client.callTool(tool, { a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("negotiates only against a caller-supplied read-only probe", async () => {
    const calls: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      calls.push(input);
      if (typeof input === "string") {
        throw new Error("Failed to parse input arguments");
      }
      return "object accepted";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const probe: RegisteredTool = {
      name: "get_context",
      description: "Reads context",
      origin: "https://shop.example",
      annotations: { readOnlyHint: true },
    };

    const negotiated = await client.negotiateEncoding({ tool: probe });
    expect(negotiated).toEqual({ ok: true, encoding: "object" });
    expect(client.encoding).toBe("object");

    calls.length = 0;
    await client.callTool(tool, { order_id: "10428" });
    expect(calls).toEqual([{ order_id: "10428" }]);
  });

  it("negotiates with caller-supplied probe input", async () => {
    const seen: unknown[] = [];
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      seen.push(input);
      // A read-only search that still requires arguments.
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      if (!parsed || typeof parsed.query !== "string") {
        throw new Error("query is required");
      }
      return "results";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const probe: RegisteredTool = {
      name: "search_customers",
      description: "Searches customers",
      origin: "https://shop.example",
      annotations: { readOnlyHint: true },
    };

    const negotiated = await client.negotiateEncoding({
      tool: probe,
      input: { query: "probe" },
    });
    expect(negotiated).toEqual({ ok: true, encoding: "string" });
    expect(seen).toEqual([`{"query":"probe"}`]);
  });

  it("reaches the object encoding for a probe that requires arguments", async () => {
    const executeTool = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input === "string") {
        throw new Error("Failed to parse input arguments");
      }
      if (typeof (input as { query?: unknown }).query !== "string") {
        throw new Error("query is required");
      }
      return "results";
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const probe: RegisteredTool = {
      name: "search_customers",
      description: "Searches customers",
      origin: "https://shop.example",
      annotations: { readOnlyHint: true },
    };

    const negotiated = await client.negotiateEncoding({
      tool: probe,
      input: { query: "probe" },
    });
    expect(negotiated).toEqual({ ok: true, encoding: "object" });
    expect(client.encoding).toBe("object");
  });

  it("says the probe input may be at fault when neither encoding works", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("query is required");
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const probe: RegisteredTool = {
      name: "search_customers",
      description: "Searches customers",
      origin: "https://shop.example",
      annotations: { readOnlyHint: true },
    };

    const negotiated = await client.negotiateEncoding({ tool: probe });
    expect(negotiated.ok).toBe(false);
    if (!negotiated.ok) {
      expect(negotiated.reason).toMatch(/probe input/i);
    }
  });

  it("refuses to negotiate against a tool that is not read-only", async () => {
    const executeTool = vi.fn(async () => "ok");
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );
    const result = await client.negotiateEncoding({ tool });
    expect(result.ok).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

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

  it("surfaces an argument-format rejection instead of retrying it", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("Failed to parse input arguments");
    });
    const client = createWebMcpClient(
      fakeModelContext({ executeTool }) as never,
    );

    const result = await client.callTool(tool, { order_id: "10428" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("sends the configured encoding on every call", async () => {
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
