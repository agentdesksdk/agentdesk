import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  unavailable,
  type Capability,
} from "@agentdesk/webmcp";
import { ARMS } from "../../scripts/evals/arms.mjs";
import { buildCatalog } from "../../scripts/evals/catalog.mjs";
import { parseTask } from "../../scripts/evals/schema.mjs";
import tasksJsonl from "../../scripts/evals/tasks/v2.tasks.jsonl?raw";

/**
 * Kept free of DOM access so a test can construct the page's runtime.
 *
 * The catalog, the arm table, and the task set are imported from the eval
 * itself rather than copied. A copy would drift, and a page that mounts a
 * catalog the eval no longer runs would score the page's vocabulary rather
 * than the model.
 */

export type ArmName = keyof typeof ARMS;
export type Arm = (typeof ARMS)[ArmName];

type RuntimeOptions = Parameters<typeof createAgentDeskRuntime>[0];

export type EvalTask = {
  id: string;
  prompt: string;
  consequential: boolean;
  unsafe: boolean;
  terminalTool: string;
  terminalInput: Record<string, unknown>;
};

export type EvalStore = {
  refunded: Set<string>;
  closed: Set<string>;
  log: string[];
};

/** `?arm=baseline` or `?arm=agentdesk`, exactly as arms.mjs spells them. */
export function armFromSearch(search: string): Arm | null {
  const value = new URLSearchParams(search).get("arm");
  if (value === null || !Object.hasOwn(ARMS, value)) {
    return null;
  }
  return ARMS[value as ArmName];
}

export const EVAL_TASKS: readonly EvalTask[] = tasksJsonl
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "")
  .map((line, index) =>
    parseTask(JSON.parse(line), `v2.tasks.jsonl line ${index + 1}`) as EvalTask,
  );

/**
 * One runtime over one fresh catalog, the unit run.mjs builds per task.
 * Calling it again is the reset: a new store, so an order refunded during
 * the last task is refundable again, and an empty audit.
 */
export function createEvalRuntime(options: {
  arm: ArmName;
  registerTool?: RuntimeOptions["registerTool"];
}): {
  arm: Arm;
  runtime: ReturnType<typeof createAgentDeskRuntime>;
  capabilities: Capability[];
  store: EvalStore;
} {
  const arm = ARMS[options.arm];
  const exposure = arm.exposure;
  if (exposure !== "flat" && exposure !== "routed") {
    throw new Error(`arms.mjs declares an exposure the SDK does not know: ${exposure}`);
  }
  const { capabilities, store } = buildCatalog(defineCapability, receipt, unavailable) as {
    capabilities: Capability[];
    store: EvalStore;
  };
  const runtime = createAgentDeskRuntime({
    capabilities,
    ...(options.registerTool ? { registerTool: options.registerTool } : {}),
    exposure,
    actor: { id: "eval-agent", name: "Eval Agent", kind: "agent" },
  });
  return { arm, runtime, capabilities, store };
}

// Stubs. The tests in tests/eval-page-shape.test.ts were written against
// these exports first; every answer here is wrong on purpose, so the tests
// fail on their assertions and not on an import.
export type ShapeName = "bare" | "structured";
export type Cell = { arm: ArmName; exposure: string; shape: ShapeName; label: string };

export const EVAL_CELLS: Record<string, Cell> = {};

export function cellHref(cell: Cell): string {
  return `?arm=${cell.arm}`;
}

export function cellFromSearch(search: string): Cell | null {
  void search;
  return null;
}

export function projectToolResult<T extends { content: Array<{ type: string; text: string }> }>(
  shape: ShapeName,
  result: T,
): T {
  void shape;
  return result;
}
