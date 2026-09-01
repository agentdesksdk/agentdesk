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
  visibleToolCount: { label: "Visible tool count (mean)", format: num },
  registeredSchemaBytes: { label: "Registered schema bytes (mean)", format: num },
  estimatedSchemaTokens: { label: "Estimated schema tokens (mean)", format: num },
};

export function buildReport({ runId, at, taskSetPath, taskCount, arms }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    at,
    taskSet: { path: taskSetPath, taskCount },
    arms,
    unavailable: Object.entries(arms).flatMap(([arm, data]) =>
      Object.entries(data.metrics)
        .filter(([, m]) => m.provenance === PROVENANCE.unavailable)
        .map(([name, m]) => ({ arm, metric: name, reason: m.reason ?? "not observed" })),
    ),
  };
}

export function renderMarkdown(report) {
  const armKeys = Object.keys(report.arms);
  const lines = [
    "# AgentDesk evaluation run",
    "",
    `Run \`${report.runId}\` at ${report.at}.`,
    "",
    `Task set \`${report.taskSet.path}\`, ${report.taskSet.taskCount} tasks, identical across every arm.`,
    "",
    "Every figure below is recomputable from the raw records in this run's",
    "directory. `unavailable` means nothing observed the value; it is not a",
    "score of zero.",
    "",
    `| Metric | ${armKeys.map((k) => report.arms[k].label).join(" | ")} | Provenance |`,
    `| --- | ${armKeys.map(() => "---").join(" | ")} | --- |`,
  ];

  for (const [name, shape] of Object.entries(SHAPE)) {
    const cells = armKeys.map((k) => shape.format(report.arms[k].metrics[name]?.value ?? null));
    const provenances = [...new Set(armKeys.map((k) => report.arms[k].metrics[name]?.provenance))];
    lines.push(`| ${shape.label} | ${cells.join(" | ")} | ${provenances.join(", ")} |`);
  }

  const coverage = armKeys
    .map((k) => [k, report.arms[k].metrics.transcriptCoverage])
    .filter(([, m]) => m && m.value !== null);
  if (coverage.length > 0) {
    lines.push("", "## Transcript coverage", "");
    lines.push("Model-dependent figures above are computed only from tasks a");
    lines.push("transcript covered. A rate computed from part of the task set is not");
    lines.push("a rate over the task set.", "");
    for (const [arm, metric] of coverage) {
      lines.push(
        `- **${report.arms[arm].label}** — ${metric.numerator} of ${metric.denominator} tasks (${pct(metric.value)}).`,
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
    "`--transcript`. Approval compliance, unsafe blocking, visible tool",
    "count, and schema bytes are runtime properties and are measured",
    "directly on both arms.",
    "",
    "Estimated schema tokens are derived, not observed. The estimator is",
    "`registeredSchemaBytes / 4`, the same divisor the shipped benchmark",
    "documentation uses.",
    "",
  );
  return lines.join("\n");
}
