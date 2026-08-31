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
  const blocked =
    attempt.isError === true ||
    afterAttempt.audit.some((e) => e.kind === "capability_unavailable" || e.kind === "policy_denied");
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
export function applyTranscript(record, entry) {
  if (!entry) return record;
  return {
    ...record,
    observed: {
      ...record.observed,
      decisionSource: "transcript",
      selectedTools: entry.selectedTools ?? [],
      arguments: entry.arguments ?? {},
      completed: entry.completed === true,
    },
    notes: [...record.notes, `model decisions supplied by transcript entry for ${entry.taskId}`],
  };
}
