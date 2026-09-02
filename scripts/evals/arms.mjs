import { runRecord } from "./schema.mjs";
import { projectResult, SHAPES } from "./shapes.mjs";

/**
 * Both arms run the identical catalog and the identical task set. The only
 * difference is exposure, which is the claim the benchmark makes, so it is
 * the only variable the runner is allowed to change before the task runs.
 */
export const ARMS = Object.freeze({
  baseline: { arm: "baseline", exposure: "flat", label: "Baseline (flat exposure)" },
  agentdesk: { arm: "agentdesk", exposure: "routed", label: "AgentDesk (routed exposure)" },
});

/**
 * The four cells the report carries: every arm under every shape. A label
 * names both, so a column cannot be read without its shape.
 */
export const CELLS = Object.freeze(
  Object.fromEntries(
    Object.values(ARMS).flatMap((arm) =>
      Object.values(SHAPES).map((shape) => [
        `${arm.arm}.${shape.shape}`,
        Object.freeze({
          arm: arm.arm,
          exposure: arm.exposure,
          shape: shape.shape,
          label: `${arm.label.replace(/ \(.*\)$/, "")} (${arm.exposure}, ${shape.shape})`,
        }),
      ]),
    ),
  ),
);

const HUMAN = Object.freeze({ id: "evaluator", name: "Evaluator", kind: "human" });

/**
 * What a client reads off a ToolResult. `data` is the protocol's payload
 * whenever the runtime built one; a handler's own ToolResult or a bare
 * error has only its text. JSON text is parsed so a shape can project it;
 * anything else is kept as the string it was.
 */
function terminalPayload(toolResult) {
  if (toolResult.data !== undefined) {
    return toolResult.data;
  }
  const text = toolResult.content?.[0]?.text;
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
 * Drives one task through a real runtime and records what happened.
 *
 * This probe deliberately does not choose tools. Tool choice is a model
 * decision, and simulating one here would manufacture exactly the numbers
 * the runner is supposed to refuse to invent. What it measures is what the
 * runtime does when an action is attempted: whether approval was demanded
 * before the write, whether an unsafe action was refused, and what surface
 * the page was holding at that moment.
 */
export async function probeTask({ createAgentDeskRuntime, capabilities, task, arm, shape, runId }) {
  if (SHAPES[shape] === undefined) {
    throw new TypeError(`shape must be one of ${Object.keys(SHAPES).join(", ")}, received ${JSON.stringify(shape)}`);
  }
  const registered = [];
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async (tool) => {
      registered.push(tool.name);
    },
    exposure: ARMS[arm].exposure,
    actor: { id: "eval-agent", name: "Eval Agent", kind: "agent" },
  });
  await runtime.start();
  await runtime.routeTask(task.prompt);

  const before = runtime.getSnapshot();
  const attempt = await runtime.invoke(task.terminalTool, { ...task.terminalInput });
  const afterAttempt = runtime.getSnapshot();

  const approvalRequested = afterAttempt.audit.some((e) => e.kind === "approval_requested");
  // Did anything actually run before a human said yes? An approval-gated
  // capability that produced a receipt without an approval event is the
  // failure this metric exists to catch.
  const executedWithoutApproval =
    runtime.queryReceipts().length > 0 && !approvalRequested;

  let approvalGranted = false;
  let granted;
  if (approvalRequested && afterAttempt.pending.length > 0) {
    granted = await runtime.approve(afterAttempt.pending[0].id, HUMAN);
    approvalGranted = granted.isError !== true;
  }

  // The terminal result is what the agent is handed once the task settles:
  // the approve outcome when a human approved, otherwise the attempt. Shape
  // is applied here, to the recorded copy, and nowhere else; the runtime ran
  // the same under both, and `approvalRequested` above is the proof.
  const result = projectResult(shape, terminalPayload(approvalGranted ? granted : attempt));

  const final = runtime.getSnapshot();
  // An exception proves a handler did not return. It does not prove the write
  // did not land. Refusal is only what the runtime declined before dispatch,
  // so it is read from the absence of execution_started rather than from any
  // error the caller happened to receive.
  const dispatched = final.audit.some((e) => e.kind === "execution_started");
  const refusalEvidence =
    attempt.isError === true ||
    final.audit.some((e) => e.kind === "capability_unavailable" || e.kind === "policy_denied");
  const blocked = !dispatched && refusalEvidence;

  const record = runRecord({
    runId,
    arm,
    shape,
    task,
    observed: {
      decisionSource: "runtime-probe",
      selectedTools: null,
      arguments: null,
      completed: null,
      approvalRequested,
      approvalGranted,
      executedWithoutApproval,
      dispatched,
      blocked,
      visibleToolCount: before.nativeTools.length,
      schemaBytes: before.schemaBytes,
      peakVisibleToolCount: Math.max(before.nativeTools.length, final.nativeTools.length),
      peakSchemaBytes: Math.max(before.schemaBytes, final.schemaBytes),
      registeredToolNames: [...new Set(registered)],
      result,
    },
    events: final.audit.map((e) => ({ kind: e.kind, at: e.at, capability: e.capability ?? null })),
    notes: [
      "tool selection, arguments, and completion are model decisions and were not observed by this probe",
    ],
  });
  await runtime.stop();
  return record;
}

/**
 * Folds a recorded model transcript onto a probe record. Only a record that
 * receives a transcript entry is scored for the model-dependent metrics; the
 * rest stay `runtime-probe` and read as unavailable rather than as failures.
 */
const TRANSCRIPT_KEYS = new Set(["taskId", "arm", "shape", "selectedTools", "arguments", "completed"]);

/**
 * A transcript entry is external input, so it is parsed rather than trusted.
 * Defaulting an absent field turned a malformed entry into a measured
 * failure, which is the same sin as inventing a model result: it reports a
 * number for something nothing observed.
 */
export function parseTranscriptEntry(entry, source = "transcript") {
  const at = (field) => `${source}: entry ${entry?.taskId ?? "<no taskId>"} ${field}`;
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError(`${source}: entry must be an object`);
  }
  for (const key of Object.keys(entry)) {
    if (!TRANSCRIPT_KEYS.has(key)) {
      throw new TypeError(`${at(key)} is an unknown field`);
    }
  }
  if (typeof entry.taskId !== "string" || entry.taskId.trim() === "") {
    throw new TypeError(`${at("taskId")} must be a non-empty string`);
  }
  if (!Array.isArray(entry.selectedTools) || entry.selectedTools.some((t) => typeof t !== "string")) {
    throw new TypeError(`${at("selectedTools")} must be an array of strings`);
  }
  if (typeof entry.arguments !== "object" || entry.arguments === null || Array.isArray(entry.arguments)) {
    throw new TypeError(`${at("arguments")} must be an object keyed by tool name`);
  }
  if (typeof entry.completed !== "boolean") {
    throw new TypeError(`${at("completed")} must be a boolean`);
  }
  return entry;
}

export function applyTranscript(record, entry) {
  if (!entry) return record;
  const parsed = parseTranscriptEntry(entry);
  return {
    ...record,
    observed: {
      ...record.observed,
      decisionSource: "transcript",
      selectedTools: [...parsed.selectedTools],
      arguments: { ...parsed.arguments },
      completed: parsed.completed,
    },
    notes: [...record.notes, `model decisions supplied by transcript entry for ${parsed.taskId}`],
  };
}
