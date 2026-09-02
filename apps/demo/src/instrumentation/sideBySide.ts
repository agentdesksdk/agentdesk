import type {
  Actor,
  AgentDeskRuntime,
  Exposure,
  RuntimeSnapshot,
} from "@agentdesk/webmcp";

/**
 * The runtime's own tools. They are registered in both modes, so the
 * application count a judge compares is the native count without them.
 */
export const BOOTSTRAP_TOOLS = [
  "find_capabilities",
  "invoke_capability",
  "get_context",
  "get_action_status",
] as const;

/** The subset of an eval task fixture the probe needs. */
export type SideBySideTask = {
  id: string;
  prompt: string;
  terminalTool: string;
  terminalInput: Record<string, unknown>;
};

/** Verbatim from `scripts/evals/tasks/v2.tasks.jsonl`; the test checks it stays so. */
export const REFUND_SHIPPING_HAPPY: SideBySideTask = {
  id: "refund-shipping-happy",
  prompt: "Refund the shipping fee on order 10428",
  terminalTool: "refund_shipping",
  terminalInput: { order_id: "10428" },
};

export type ArmMeasurement = {
  exposure: Exposure;
  /** Highest native tool count across the samples, bootstrap included. */
  peakVisibleToolCount: number;
  /** `peakVisibleToolCount` without the runtime's own tools. */
  peakApplicationTools: number;
  peakSchemaBytes: number;
  approvalRequested: boolean;
  /** Refused before dispatch, with evidence of the refusal. */
  blocked: boolean;
  /** Something ran, with or without approval. */
  dispatched: boolean;
};

const applicationTools = (snapshot: RuntimeSnapshot): number =>
  snapshot.nativeTools.filter(
    (name) => !(BOOTSTRAP_TOOLS as readonly string[]).includes(name),
  ).length;

/**
 * Runs one task under the runtime's current exposure and reports the
 * task-time peak. The steps and the reading of them are the ones
 * `probeTask` in `scripts/evals/arms.mjs` takes, so a row here and a record
 * from `pnpm eval` describe the same measurement; the test holds them equal.
 *
 * Both surface figures are the larger of two samples: after routing and
 * after execution. An idle snapshot is never reported, because in routed
 * mode it would flatter AgentDesk by measuring nothing.
 */
export async function measureArm(
  runtime: AgentDeskRuntime,
  task: SideBySideTask,
  options: { approver: Actor },
): Promise<ArmMeasurement> {
  await runtime.routeTask(task.prompt);
  const afterRouting = runtime.getSnapshot();

  const attempt = await runtime.invoke(task.terminalTool, { ...task.terminalInput });
  const afterAttempt = runtime.getSnapshot();
  const approvalRequested = afterAttempt.audit.some((e) => e.kind === "approval_requested");

  if (approvalRequested && afterAttempt.pending.length > 0) {
    await runtime.approve(afterAttempt.pending[0]!.id, options.approver);
  }

  const final = runtime.getSnapshot();
  const dispatched = final.audit.some((e) => e.kind === "execution_started");
  const refusalEvidence =
    attempt.isError === true ||
    final.audit.some(
      (e) => e.kind === "capability_unavailable" || e.kind === "policy_denied",
    );

  return {
    exposure: final.exposure,
    peakVisibleToolCount: Math.max(afterRouting.nativeTools.length, final.nativeTools.length),
    peakApplicationTools: Math.max(applicationTools(afterRouting), applicationTools(final)),
    peakSchemaBytes: Math.max(afterRouting.schemaBytes, final.schemaBytes),
    approvalRequested,
    blocked: !dispatched && refusalEvidence,
    dispatched,
  };
}

export const SIDE_BY_SIDE_EXPOSURES: readonly Exposure[] = ["flat", "routed"];

/**
 * The same task under both exposures, in sequence, on one runtime.
 *
 * `reset` runs before each arm, so both start from the same seed the way
 * each eval arm gets a fresh catalog, and once more at the end so the page
 * is handed back untouched. The exposure the runtime had when the run
 * began is restored last.
 */
export async function runSideBySide(options: {
  runtime: AgentDeskRuntime;
  task: SideBySideTask;
  approver: Actor;
  reset: () => Promise<void>;
  exposures?: readonly Exposure[];
}): Promise<ArmMeasurement[]> {
  const { runtime, task, approver, reset } = options;
  const exposures = options.exposures ?? SIDE_BY_SIDE_EXPOSURES;
  const original = runtime.getSnapshot().exposure;
  const rows: ArmMeasurement[] = [];
  try {
    for (const exposure of exposures) {
      await reset();
      await runtime.setExposure(exposure);
      rows.push(await measureArm(runtime, task, { approver }));
    }
  } finally {
    await reset();
    await runtime.setExposure(original);
  }
  return rows;
}
