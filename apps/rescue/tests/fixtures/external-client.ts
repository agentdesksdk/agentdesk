import type { AgentDeskRuntime, NativeToolDefinition, RegisterToolFn, ToolResult } from "@agentdesksdk/webmcp";

/**
 * The external client, as the tests play it: a model context the page's
 * runtime registers tools into, and an agent that calls those tools with
 * the hero prompt. Nothing here is page code; the page renders what the
 * runtime records and never calls a tool itself.
 */
export const HERO_PROMPT =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

export const RESCUE_OPERATIONS = [
  { capability: "reserve_oxygen", input: { packs: 2 } },
  { capability: "assign_rescue_drone", input: { drone: "NIA-7", mission: "AST-10428" } },
  { capability: "reroute_dock_power", input: { dock: "Dock 3", percent: 65 } },
  { capability: "launch_rescue", input: { mission: "AST-10428" } },
];

export const RESCUE_SUMMARY =
  "Rescue the Asteria crew: reserve two oxygen packs, assign NIA-7, reroute power to Dock 3, launch AST-10428.";

/** The tools a page hands the runtime, kept so a test can see what registered. */
export function mockModelContext() {
  const tools = new Map<string, NativeToolDefinition>();
  const registerTool: RegisterToolFn = async (tool, options) => {
    tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      tools.delete(tool.name);
    });
  };
  return { tools, registerTool };
}

export function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

/**
 * The agent's first turn: discover, read, and stage the plan through the
 * governance gateway. It ends with a plan awaiting a person; the agent
 * cannot approve it.
 */
export async function firstTurn(runtime: AgentDeskRuntime, prompt = HERO_PROMPT) {
  const routed = await runtime.invoke("find_capabilities", { query: prompt });
  // The reads go through invoke_capability by name, the gateway a client
  // uses for any capability it learned of from find_capabilities.
  const crew = await runtime.invoke("invoke_capability", { name: "find_stranded_crew" });
  const conditions = await runtime.invoke("invoke_capability", { name: "inspect_rescue_conditions" });
  const prepared = await runtime.invoke("invoke_capability", {
    name: "prepare_plan",
    input: { operations: RESCUE_OPERATIONS, summary: RESCUE_SUMMARY },
  });
  const planId = payload(prepared).plan_id;
  return {
    routed: payload(routed),
    crew: payload(crew),
    conditions: payload(conditions),
    prepared: payload(prepared),
    planId: typeof planId === "string" ? planId : undefined,
  };
}

/**
 * The agent's next turn, after a person decided: commit the approved plan
 * and read the receipts back.
 */
export async function secondTurn(runtime: AgentDeskRuntime, planId: string) {
  const committed = await runtime.invoke("invoke_capability", { name: "commit_plan", input: { plan_id: planId } });
  const receipts = await runtime.invoke("invoke_capability", { name: "query_receipts", input: { plan_id: planId } });
  return { committed: payload(committed), receipts: payload(receipts) };
}
