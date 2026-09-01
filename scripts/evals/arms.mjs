import { runRecord } from "./schema.mjs";

/**
 * Both arms run the identical catalog and the identical task set. The only
 * difference is exposure, which is the claim the benchmark makes, so it is
 * the only variable the runner is allowed to change.
 */
export const ARMS = Object.freeze({
  baseline: { arm: "baseline", exposure: "flat", label: "Baseline (flat exposure)" },
  agentdesk: { arm: "agentdesk", exposure: "routed", label: "AgentDesk (routed exposure)" },
});

const HUMAN = Object.freeze({ id: "evaluator", name: "Evaluator", kind: "human" });

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
export async function probeTask({ createAgentDeskRuntime, capabilities, task, arm, runId }) {
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
  if (approvalRequested && afterAttempt.pending.length > 0) {
    const granted = await runtime.approve(afterAttempt.pending[0].id, HUMAN);
    approvalGranted = granted.isError !== true;
  }

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
const TRANSCRIPT_KEYS = new Set(["taskId", "arm", "selectedTools", "arguments", "completed"]);

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
