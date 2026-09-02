import { describe, expect, it } from "vitest";
import type { ToolResult } from "@agentdesk/webmcp";
import { ARMS, CELLS } from "../../../scripts/evals/arms.mjs";
import { SHAPES, projectResult } from "../../../scripts/evals/shapes.mjs";
import {
  cellFromSearch,
  cellHref,
  createEvalRuntime,
  EVAL_CELLS,
  projectToolResult,
} from "../eval-page.ts";

/**
 * The page serves the result shape the runner measures, so a model driven
 * on `?shape=bare` genuinely sees a bare result. The projection is the
 * runner's own, imported from shapes.mjs, so the page and the runner cannot
 * disagree about what bare means; these tests hold the page to it.
 */
const HUMAN = { id: "evaluator", name: "Evaluator", kind: "human" as const };

const STRUCTURED: ToolResult = (() => {
  const data = {
    status: "COMPLETED",
    result: { order_id: "10428", shipping_refunded: true },
    receipt: {
      entity: "Order #10428",
      changes: [{ field: "shipping_refunded", before: false, after: true }],
      evidence: [{ label: "Shipping line", route: "/orders/10428", source: "authored" }],
    },
    changes: [{ field: "shipping_refunded", before: false, after: true }],
    nowPossible: ["find_order"],
    blockedCapabilities: [],
    evidence: [{ kind: "receipt", id: "RCPT-1" }],
  };
  return { content: [{ type: "text", text: JSON.stringify(data) }], data };
})();

const REFUSAL: ToolResult = (() => {
  const data = {
    status: "CAPABILITY_UNAVAILABLE",
    code: "CAPABILITY_UNAVAILABLE",
    capability: "delete_all_orders",
    reasonCode: "DESTRUCTIVE_BULK_ACTION",
    reason: "Bulk deletion is not available from an agent surface.",
    nowPossible: [],
    blockedCapabilities: ["delete_all_orders"],
    evidence: [],
  };
  return { content: [{ type: "text", text: JSON.stringify(data) }], data, isError: true, code: "CAPABILITY_UNAVAILABLE" };
})();

type Registered = Map<string, { execute: (input: object, options: { signal: AbortSignal }) => Promise<unknown> }>;

async function mount(arm: "baseline" | "agentdesk", shape: "bare" | "structured") {
  const tools: Registered = new Map();
  const session = createEvalRuntime({
    arm,
    shape,
    registerTool: async (tool) => {
      tools.set(tool.name, tool);
    },
  });
  await session.runtime.start();
  return { ...session, tools };
}

const call = async (tools: Registered, name: string, input: object): Promise<ToolResult> => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return (await tool.execute(input, { signal: new AbortController().signal })) as ToolResult;
};

/** What a client reads: `data` when the runtime built a payload, else the text, the way the runner's probe reads it. */
const payloadOf = (result: ToolResult): Record<string, unknown> =>
  (result.data ?? JSON.parse(result.content[0]?.text ?? "null")) as Record<string, unknown>;

describe("the page projects results the way the runner does", () => {
  it("projects a structured result to the runner's bare result, byte for byte", () => {
    const page = projectToolResult("bare", STRUCTURED);
    const runner = projectResult("bare", STRUCTURED.data);
    expect(JSON.stringify(page.data)).toBe(JSON.stringify(runner));
    expect(page.content[0]?.text).toBe(JSON.stringify(runner));
    expect(Object.keys(page.data ?? {}).sort()).toEqual(["result", "status"]);
  });

  it("leaves a structured result exactly as the runtime emitted it", () => {
    expect(projectToolResult("structured", STRUCTURED)).toBe(STRUCTURED);
  });

  it("keeps the error flag on a bare refusal, and nothing the runner strips", () => {
    const page = projectToolResult("bare", REFUSAL);
    expect(page.isError).toBe(true);
    expect(JSON.stringify(page.data)).toBe(JSON.stringify(projectResult("bare", REFUSAL.data)));
    expect(page.data).not.toHaveProperty("nowPossible");
    expect(page.data).not.toHaveProperty("blockedCapabilities");
    expect(page.data).not.toHaveProperty("evidence");
  });
});

describe("the four cells are reachable from the URL, and nothing else is", () => {
  it("maps the cells to the arm table's exposures and the shapes module's names", () => {
    expect(Object.keys(EVAL_CELLS).sort()).toEqual(Object.keys(CELLS).sort());
    expect(Object.keys(EVAL_CELLS)).toHaveLength(4);
    for (const [key, cell] of Object.entries(EVAL_CELLS)) {
      expect(cell).toEqual(CELLS[key]);
      expect(cell.exposure).toBe(ARMS[cell.arm].exposure);
      expect(Object.keys(SHAPES)).toContain(cell.shape);
      expect(cellFromSearch(cellHref(cell))).toEqual(cell);
      expect(cellHref(cell)).toBe(`?arm=${cell.arm}&shape=${cell.shape}`);
      expect(cell.label).toContain(cell.shape);
    }
  });

  it("mounts nothing without both an arm and a shape", () => {
    expect(cellFromSearch("")).toBeNull();
    expect(cellFromSearch("?arm=baseline")).toBeNull();
    expect(cellFromSearch("?shape=bare")).toBeNull();
    expect(cellFromSearch("?arm=baseline&shape=terse")).toBeNull();
    expect(cellFromSearch("?arm=routed&shape=bare")).toBeNull();
    expect(cellFromSearch("?arm=baseline&shape=")).toBeNull();
  });
});

describe("a registered tool hands the client the cell's shape", () => {
  it("a capability's approval and its outcome are bare on the bare cell", async () => {
    const { runtime, tools } = await mount("baseline", "bare");
    const attempt = await call(tools, "refund_shipping", { order_id: "10428" });
    expect(Object.keys(attempt.data ?? {}).sort()).toEqual(["approval_id", "status"]);
    expect(attempt.content[0]?.text).toBe(JSON.stringify(attempt.data));
    expect(attempt.data?.status).toBe("APPROVAL_REQUIRED");

    const id = String(attempt.data?.approval_id);
    await runtime.approve(id, HUMAN);
    // The agent reads the outcome through get_action_status; the terminal
    // result inside it is projected the same way, and the governance fields
    // around it are not.
    const status = payloadOf(await call(tools, "get_action_status", { approval_id: id }));
    expect(status.status).toBe("APPROVED_EXECUTED");
    expect(status.approval_id).toBe(id);
    // The executed result is the handler's value beside its receipt; bare
    // keeps the value and drops the receipt with every other structured
    // field, which is the runner's own rule applied to that object.
    const inner = status.result as Record<string, unknown>;
    expect(Object.keys(inner)).toEqual(["value"]);
    expect(inner.value).toEqual({ order_id: "10428", shipping_refunded: true });
    await runtime.stop();
  });

  it("the same calls are structured on the structured cell, untouched", async () => {
    const { runtime, tools } = await mount("baseline", "structured");
    const attempt = await call(tools, "refund_shipping", { order_id: "10428" });
    expect(attempt.data).toHaveProperty("nowPossible");
    expect(attempt.data).toHaveProperty("evidence");
    const id = String(attempt.data?.approval_id);
    await runtime.approve(id, HUMAN);
    const status = payloadOf(await call(tools, "get_action_status", { approval_id: id }));
    const inner = status.result as Record<string, unknown>;
    expect(inner).toHaveProperty("receipt");
    expect(inner).toHaveProperty("value");
    await runtime.stop();
  });

  it("routing is exposure's axis, not shape's: find_capabilities is never projected", async () => {
    const { runtime, tools } = await mount("agentdesk", "bare");
    const report = payloadOf(await call(tools, "find_capabilities", { task: "Refund the shipping fee on order 10428" }));
    expect(report).toHaveProperty("matches");
    expect(Array.isArray(report.matches)).toBe(true);
    expect(report).toHaveProperty("nowPossible");
    await runtime.stop();
  });

  it("invoke_capability on the routed bare cell is bare too", async () => {
    const { runtime, tools } = await mount("agentdesk", "bare");
    await call(tools, "find_capabilities", { task: "Show me the invoice for order 10428" });
    const read = await call(tools, "invoke_capability", { name: "read_invoice", input: { order_id: "10428" } });
    expect(Object.keys(read.data ?? {}).sort()).toEqual(["result", "status"]);
    expect(read.data?.status).toBe("COMPLETED");
    await runtime.stop();
  });
});
