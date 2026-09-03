import { beforeEach, describe, expect, it } from "vitest";
import {
  catalogHierarchy,
  createAgentDeskRuntime,
  type NativeToolDefinition,
} from "@agentdesksdk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { stagingAdapter } from "../src/capabilities/staged.ts";
import { resetStore } from "../src/data/store.ts";

const MISSED_ONE_CALL_TASKS = [
  {
    prompt: "Mark order 10428 shipped.",
    expected: "mark_order_shipped",
  },
  {
    prompt: "Get invoice INV-3021.",
    expected: "get_invoice",
  },
  {
    prompt: "Get ticket T-2001.",
    expected: "get_ticket",
  },
  {
    prompt: "Assign support ticket T-2001 to agent Mia.",
    expected: "assign_ticket",
  },
] as const;

const MULTI_STEP_PROMPT =
  "Add an internal note to order 10428, mark order 10408 shipped, assign support ticket T-2001 to agent Mia, adjust stock for a product, and apply a customer credit.";

describe("default autonomous routing", () => {
  beforeEach(() => {
    resetStore();
  });

  it("recognizes the distinct domains in each clause of the hero task", () => {
    const hierarchy = catalogHierarchy(capabilities);
    const all = () => true;
    const orderClause = hierarchy.rankDomains(
      "Find Alice Johnson's unshipped order",
      all,
    );
    const orderDomain = orderClause.find((entry) => entry.domain === "orders");

    expect(orderDomain?.score).toBeGreaterThanOrEqual(0.75 * orderClause[0]!.score);
    expect(
      hierarchy.rankDomains("If she paid shipping, refund the shipping fee", all)[0]
        ?.domain,
    ).toBe("shipping");
  });

  for (const task of MISSED_ONE_CALL_TASKS) {
    it(`routes ${task.expected} in the first call`, async () => {
      const tools = new Map<string, NativeToolDefinition>();
      const runtime = createAgentDeskRuntime({
        capabilities,
        registerTool: async (tool, options) => {
          tools.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => {
            if (tools.get(tool.name) === tool) {
              tools.delete(tool.name);
            }
          });
        },
        staging: stagingAdapter,
      });
      await runtime.start();

      await runtime.routeTask(task.prompt);

      const routed = runtime.getSnapshot().routedTools;
      expect(routed, `routed: ${routed.join(", ")}`).toContain(task.expected);
      expect(routed.length).toBeLessThanOrEqual(6);
      expect(tools.has(task.expected)).toBe(true);
      expect(tools.size).toBeLessThanOrEqual(10);
    });
  }

  it("keeps every target reachable while the same agent routes all three tasks in sequence", async () => {
    const tools = new Map<string, NativeToolDefinition>();
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async (tool, options) => {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => {
          if (tools.get(tool.name) === tool) {
            tools.delete(tool.name);
          }
        });
      },
      staging: stagingAdapter,
    });
    await runtime.start();

    for (const task of MISSED_ONE_CALL_TASKS) {
      await runtime.routeTask(task.prompt);
      expect(tools.has(task.expected), `${task.expected} was not registered`).toBe(true);
      const snapshot = runtime.getSnapshot();
      const live = snapshot.nativeTools.filter(
        (name) => !snapshot.tombstones.includes(name),
      );
      expect(live.length).toBeLessThanOrEqual(10);
      expect(snapshot.tombstones.length).toBeLessThanOrEqual(6);
      expect(tools.size).toBeLessThanOrEqual(16);
    }
  });

  it("keeps one actionable capability for every clause of a five-step request", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
    });
    await runtime.start();

    await runtime.routeTask(MULTI_STEP_PROMPT);

    expect(runtime.getSnapshot().routedTools).toEqual(
      expect.arrayContaining([
        "add_order_note",
        "mark_order_shipped",
        "assign_ticket",
        "adjust_stock",
        "issue_credit",
      ]),
    );
    expect(runtime.getSnapshot().routedTools).toHaveLength(5);
  });
});
