import { PROVENANCE, REPORT_SCHEMA_VERSION } from "./schema.mjs";

const pct = (v) => (v === null ? "unavailable" : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null ? "unavailable" : Math.round(v).toLocaleString("en-US"));

const SHAPE = {
  toolSelectionAccuracy: { label: "Tool-selection accuracy (per-arm trace)", format: pct },
  terminalToolAccuracy: { label: "Terminal-tool accuracy (arm-neutral)", format: pct },
  argumentAccuracy: { label: "Argument accuracy", format: pct },
  taskCompletion: { label: "Task completion", format: pct },
  approvalCompliance: { label: "Approval compliance", format: pct },
  unsafeExecutionsBlocked: { label: "Unsafe executions blocked", format: pct },
  evidenceCoverage: { label: "Evidence coverage (consequential completions with a link)", format: pct },
  visibleToolCount: { label: "Visible tool count (mean)", format: num },
  registeredSchemaBytes: { label: "Registered schema bytes (mean)", format: num },
  estimatedSchemaTokens: { label: "Estimated schema tokens (mean)", format: num },
  resultBytes: { label: "Result bytes (mean)", format: num },
  estimatedResultTokens: { label: "Estimated result tokens (mean)", format: num },
};

/**
 * `cells` is every arm under every shape, keyed `arm.shape`, each carrying
 * its arm, exposure, shape, label, and metrics. An unavailable entry names
 * the cell's arm and shape, so a reader can tell which of the four cells
 * has no value rather than which arm.
 */
export function buildReport({ runId, at, taskSetPath, taskCount, cells }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    at,
    taskSet: { path: taskSetPath, taskCount },
    cells,
    unavailable: Object.entries(cells).flatMap(([, cell]) =>
      Object.entries(cell.metrics)
        .filter(([, m]) => m.provenance === PROVENANCE.unavailable)
        .map(([name, m]) => ({ arm: cell.arm, shape: cell.shape, metric: name, reason: m.reason ?? "not observed" })),
    ),
  };
}

export function renderMarkdown(report) {
  const keys = Object.keys(report.cells);
  const lines = [
    "# AgentDesk evaluation run",
    "",
    `Run \`${report.runId}\` at ${report.at}.`,
    "",
    `Task set \`${report.taskSet.path}\`, ${report.taskSet.taskCount} tasks, identical across every cell.`,
    "",
    "Two axes. Exposure, `flat` against `routed`, is what the agent can see",
    "before it acts. Result shape, `bare` against `structured`, is what it is",
    "handed after. Every cell ran the same catalog, the same tasks, the same",
    "handlers, and the same policy.",
    "",
    "Every figure below is recomputable from the raw records in this run's",
    "directory. `unavailable` means nothing observed the value; it is not a",
    "score of zero.",
    "",
    `| Metric | ${keys.map((k) => report.cells[k].label).join(" | ")} | Provenance |`,
    `| --- | ${keys.map(() => "---").join(" | ")} | --- |`,
  ];

  for (const [name, shape] of Object.entries(SHAPE)) {
    const cells = keys.map((k) => shape.format(report.cells[k].metrics[name]?.value ?? null));
    const provenances = [...new Set(keys.map((k) => report.cells[k].metrics[name]?.provenance))];
    lines.push(`| ${shape.label} | ${cells.join(" | ")} | ${provenances.join(", ")} |`);
  }

  const coverage = keys
    .map((k) => [k, report.cells[k].metrics.transcriptCoverage])
    .filter(([, m]) => m && m.value !== null);
  if (coverage.length > 0) {
    lines.push("", "## Transcript coverage", "");
    lines.push("Model-dependent figures above are computed only from tasks a");
    lines.push("transcript covered. A rate computed from part of the task set is not");
    lines.push("a rate over the task set.", "");
    for (const [key, metric] of coverage) {
      lines.push(
        `- **${report.cells[key].label}** — ${metric.numerator} of ${metric.denominator} tasks (${pct(metric.value)}).`,
      );
    }
  }

  if (report.unavailable.length > 0) {
    lines.push("", "## Unavailable", "");
    lines.push("These were not measured. No value is reported for them, and no");
    lines.push("value should be quoted from this run.", "");
    const seen = new Set();
    for (const entry of report.unavailable) {
      const key = `${entry.metric}: ${entry.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- **${entry.metric}** — ${entry.reason}`);
    }
  }

  lines.push(
    "",
    "## Reading this",
    "",
    "Tool selection, argument accuracy, and task completion are model",
    "decisions. This runner does not simulate a model, so they are",
    "`unavailable` unless a recorded transcript was supplied with",
    "`--transcript`, and a transcript scores only the cell whose arm and",
    "shape it names. Approval compliance, unsafe blocking, evidence",
    "coverage, visible tool count, schema bytes, and result bytes are",
    "runtime properties and are measured directly in every cell.",
    "",
    "A `bare` cell hands the agent the terminal result stripped to what a",
    "plain handler returns: the value, or the message, and an approval id.",
    "A `structured` cell hands it what the runtime emits: the receipt, the",
    "changes, what is now possible, what stays blocked, a repair, and the",
    "evidence. Evidence coverage on a bare cell is zero by construction and",
    "is reported as measured, because the agent was handed nothing. Result",
    "bytes are what the difference costs.",
    "",
    "Estimated tokens are derived, not observed. The estimators are",
    "`registeredSchemaBytes / 4` and `resultBytes / 4`, the same divisor the",
    "shipped benchmark documentation uses.",
    "",
  );
  return lines.join("\n");
}
