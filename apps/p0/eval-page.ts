import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  unavailable,
  type Capability,
  type NativeToolDefinition,
  type RegisterToolFn,
  type ToolResult,
} from "@agentdesksdk/webmcp";
import { ARMS, CELLS } from "../../scripts/evals/arms.mjs";
import { buildCatalog } from "../../scripts/evals/catalog.mjs";
import { parseTask, STRUCTURED_FIELDS } from "../../scripts/evals/schema.mjs";
import { SHAPES, projectResult } from "../../scripts/evals/shapes.mjs";
import tasksJsonl from "../../scripts/evals/tasks/v2.tasks.jsonl?raw";

/**
 * Kept free of DOM access so a test can construct the page's runtime.
 *
 * The catalog, the arm table, the cell table, the shape projection, and
 * the task set are imported from the eval itself rather than copied. A
 * copy would drift, and a page that mounts a catalog the eval no longer
 * runs, or that means something else by "bare", would score the page's
 * vocabulary rather than the model.
 */

export type ArmName = keyof typeof ARMS;
export type Arm = (typeof ARMS)[ArmName];
export type ShapeName = keyof typeof SHAPES;

/** One of the four cells the report carries: an arm under a shape. */
export type Cell = {
  arm: ArmName;
  exposure: Arm["exposure"];
  shape: ShapeName;
  label: string;
};

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

function isArmName(value: string): value is ArmName {
  return Object.hasOwn(ARMS, value);
}

function isShapeName(value: string): value is ShapeName {
  return Object.hasOwn(SHAPES, value);
}

/**
 * The cell table as the page knows it, narrowed from arms.mjs at load. A
 * cell naming an arm or a shape the page does not know is a defect in the
 * eval, not something to mount.
 */
export const EVAL_CELLS: Readonly<Record<string, Cell>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CELLS).map(([key, raw]) => {
      if (!isArmName(raw.arm) || !isShapeName(raw.shape)) {
        throw new Error(`arms.mjs declares a cell the page does not know: ${key}`);
      }
      const cell: Cell = { arm: raw.arm, exposure: ARMS[raw.arm].exposure, shape: raw.shape, label: raw.label };
      return [key, Object.freeze(cell)];
    }),
  ),
);

/** `?arm=baseline&shape=bare`, exactly as the cell table spells them. */
export function cellHref(cell: Cell): string {
  return `?arm=${cell.arm}&shape=${cell.shape}`;
}

/**
 * Both parameters, or nothing. Defaulting a missing shape to `structured`
 * would let a person drive a cell they did not choose and record the
 * transcript under the wrong one.
 */
export function cellFromSearch(search: string): Cell | null {
  const params = new URLSearchParams(search);
  const arm = params.get("arm");
  const shape = params.get("shape");
  if (arm === null || shape === null) {
    return null;
  }
  const key = `${arm}.${shape}`;
  return Object.hasOwn(EVAL_CELLS, key) ? (EVAL_CELLS[key] ?? null) : null;
}

/** `?arm=baseline` or `?arm=agentdesk`, exactly as arms.mjs spells them. */
export function armFromSearch(search: string): Arm | null {
  const value = new URLSearchParams(search).get("arm");
  if (value === null || !isArmName(value)) {
    return null;
  }
  return ARMS[value];
}

export const EVAL_TASKS: readonly EvalTask[] = tasksJsonl
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "")
  .map((line, index) =>
    parseTask(JSON.parse(line), `v2.tasks.jsonl line ${index + 1}`) as EvalTask,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolResult = (value: unknown): value is ToolResult =>
  isRecord(value) && Array.isArray(value.content);

/**
 * What a client reads off a tool result, the way the runner's probe reads
 * it: the protocol's payload when the runtime built one, else the text,
 * parsed when it is JSON and kept as the string it was otherwise.
 */
function terminalPayload(result: ToolResult): unknown {
  if (result.data !== undefined) {
    return result.data;
  }
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The page's projection is the runner's: `projectResult` from shapes.mjs
 * over the same payload the probe projects. A structured result is handed
 * through as the runtime emitted it. A bare one is rebuilt around the
 * projected payload, keeping only the error flag, which is what a plain
 * handler's throw would have conveyed; `code` and everything the runner
 * strips go with the payload.
 */
export function projectToolResult(shape: ShapeName, result: ToolResult): ToolResult {
  if (shape === "structured") {
    return result;
  }
  const projected: unknown = projectResult(shape, terminalPayload(result));
  const text = typeof projected === "string" ? projected : JSON.stringify(projected);
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (isRecord(projected)) {
    out.data = projected;
  }
  if (result.isError === true) {
    out.isError = true;
  }
  return out;
}

/**
 * `get_action_status` is governance around a terminal result. The status
 * and the ids are what the agent polls with and stay. The result inside,
 * once the action executed, is the stored execution result, the handler's
 * `value` beside its `receipt`, which the runner never sees because its
 * probe reads the approve call's own result. The bare form of it is the
 * runner's rule applied to that object: the value stays, and every field
 * schema.mjs names as structured, the receipt first, is dropped. A result
 * that is itself a tool result is projected as one.
 */
function projectActionStatus(shape: ShapeName, result: ToolResult): ToolResult {
  const payload = terminalPayload(result);
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return result;
  }
  const inner = payload.result;
  const projectedInner: unknown = isToolResult(inner)
    ? projectToolResult(shape, inner)
    : Object.fromEntries(Object.entries(inner).filter(([key]) => !STRUCTURED_FIELDS.includes(key)));
  const projected = { ...payload, result: projectedInner };
  const out: ToolResult = { ...result, content: [{ type: "text", text: JSON.stringify(projected) }] };
  if (result.data !== undefined) {
    out.data = projected;
  }
  return out;
}

/**
 * Routing is exposure's axis, not shape's. `find_capabilities` and
 * `get_context` describe the surface and are never projected, which is
 * also what the runner does: its probe projects the terminal result of an
 * invocation and nothing before it.
 */
const UNPROJECTED = new Set(["find_capabilities", "get_context"]);

/** The tool as the client will hold it: its results projected to the cell's shape. */
export function projectTool(shape: ShapeName, tool: NativeToolDefinition): NativeToolDefinition {
  if (shape === "structured" || UNPROJECTED.has(tool.name)) {
    return tool;
  }
  const project = tool.name === "get_action_status" ? projectActionStatus : projectToolResult;
  return {
    ...tool,
    execute: async (input, options) => project(shape, (await tool.execute(input, options)) as ToolResult),
  };
}

/**
 * One runtime over one fresh catalog, the unit run.mjs builds per task.
 * Calling it again is the reset: a new store, so an order refunded during
 * the last task is refundable again, and an empty audit.
 *
 * `registerTool` is where the shape is applied: every tool the runtime
 * registers is wrapped before it reaches the sink, or the page's
 * `document.modelContext`, so a client on a bare cell holds bare tools. A
 * bare cell therefore needs a `registerTool` to wrap; without one the
 * runtime would register unprojected tools itself.
 */
export function createEvalRuntime(options: {
  arm: ArmName;
  shape?: ShapeName;
  registerTool?: RuntimeOptions["registerTool"];
}): {
  arm: Arm;
  shape: ShapeName;
  runtime: ReturnType<typeof createAgentDeskRuntime>;
  capabilities: Capability[];
  store: EvalStore;
} {
  const arm = ARMS[options.arm];
  const shape: ShapeName = options.shape ?? "structured";
  const exposure = arm.exposure;
  if (exposure !== "flat" && exposure !== "routed") {
    throw new Error(`arms.mjs declares an exposure the SDK does not know: ${exposure}`);
  }
  const given = options.registerTool;
  if (shape !== "structured" && !given) {
    throw new Error(`a ${shape} cell needs a registerTool for the page to project through`);
  }
  const registerTool: RegisterToolFn | undefined = given
    ? async (tool, registerOptions) => {
        await given(projectTool(shape, tool), registerOptions);
      }
    : undefined;
  const { capabilities, store } = buildCatalog(defineCapability, receipt, unavailable) as {
    capabilities: Capability[];
    store: EvalStore;
  };
  const runtime = createAgentDeskRuntime({
    capabilities,
    ...(registerTool ? { registerTool } : {}),
    exposure,
    actor: { id: "eval-agent", name: "Eval Agent", kind: "agent" },
  });
  return { arm, shape, runtime, capabilities, store };
}
