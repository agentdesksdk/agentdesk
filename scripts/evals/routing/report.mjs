import { PROVENANCE, ROUTING_REPORT_SCHEMA_VERSION } from "./schema.mjs";

const LABELS = Object.freeze({
  deterministic: "Deterministic (lexical, the shipped default)",
  hybrid: "Hybrid (lexical plus graph and session)",
});

const pct = (v) => (v === null ? "unavailable" : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null ? "unavailable" : Math.round(v).toLocaleString("en-US"));
const dec = (v) => (v === null ? "unavailable" : v.toFixed(2));

const ROWS = {
  terminalInRoutedSet: { label: "Expected capability in the routed set", format: pct },
  terminalRank: { label: "Rank of the expected capability, when routed (mean)", format: dec },
  routedSetSize: { label: "Routed set size (mean)", format: dec },
  schemaBytes: { label: "Schema bytes the routed set registers (mean)", format: num },
  tieAtCut: { label: "Tie at the cut", format: pct },
  metadataOverlap: { label: "Prompt overlap with the expected metadata (mean)", format: dec },
};

export function buildRoutingReport({ runId, at, taskSetPath, taskCount, catalog, cells }) {
  return {
    schemaVersion: ROUTING_REPORT_SCHEMA_VERSION,
    runId,
    at,
    taskSet: { path: taskSetPath, taskCount },
    catalog,
    cells,
    unavailable: Object.entries(cells).flatMap(([strategy, cell]) =>
      Object.entries(cell.metrics)
        .filter(([, m]) => m.provenance === PROVENANCE.unavailable)
        .map(([name, m]) => ({ strategy, metric: name, reason: m.reason ?? "not observed" })),
    ),
  };
}

export function renderRoutingMarkdown(report) {
  const keys = Object.keys(report.cells);
  const lines = [
    "# AgentDesk routing stress evaluation",
    "",
    `Run \`${report.runId}\` at ${report.at}.`,
    "",
    `Catalog: ${report.catalog.size} generated capabilities across ${report.catalog.domains.length} domains, seed ${report.catalog.seed}.`,
    `Task set \`${report.taskSet.path}\`, ${report.taskSet.taskCount} held-out tasks, identical across every strategy.`,
    "",
    "Every figure below is runtime-measured and recomputable from the raw",
    "records in this run's directory. No model was involved: the question is",
    "what the router publishes for a messy phrasing, not what an agent then",
    "does with it. `unavailable` means nothing observed the value.",
    "",
    `| Metric | ${keys.map((k) => LABELS[k] ?? k).join(" | ")} | Provenance |`,
    `| --- | ${keys.map(() => "---").join(" | ")} | --- |`,
  ];
  for (const [name, row] of Object.entries(ROWS)) {
    const cells = keys.map((k) => row.format(report.cells[k].metrics[name]?.value ?? null));
    const provenances = [...new Set(keys.map((k) => report.cells[k].metrics[name]?.provenance))];
    lines.push(`| ${row.label} | ${cells.join(" | ")} | ${provenances.join(", ")} |`);
  }

  lines.push("", "## What the current scorer gets wrong", "");
  for (const key of keys) {
    const cell = report.cells[key];
    const metric = cell.metrics.terminalInRoutedSet;
    lines.push(`### ${LABELS[key] ?? key}`, "");
    if (metric.value === null) {
      lines.push("No tasks ran.", "");
      continue;
    }
    lines.push(
      `${metric.denominator - metric.numerator} of ${metric.denominator} tasks did not route their expected capability into the set of ${report.cells[key].metrics.routedSetSize.max ?? "?"} the runtime would publish.`,
      "",
    );
    if (cell.failing.length === 0) {
      lines.push("Nothing failed.", "");
      continue;
    }
    lines.push("| Task | Prompt | Expected | Rank | Routed instead |", "| --- | --- | --- | --- | --- |");
    for (const f of cell.failing) {
      const rank = f.rank === null ? "none in top six" : String(f.rank);
      const routed = f.routed.length === 0 ? "nothing" : f.routed.map((n) => `\`${n}\``).join(", ");
      lines.push(`| \`${f.taskId}\` | ${f.prompt.replaceAll("|", "\\|")} | \`${f.expected}\` | ${rank} | ${routed} |`);
    }
    lines.push("");
  }

  if (report.unavailable.length > 0) {
    lines.push("## Unavailable", "");
    const seen = new Set();
    for (const entry of report.unavailable) {
      const key = `${entry.metric}: ${entry.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- **${entry.metric}** — ${entry.reason}`);
    }
    lines.push("");
  }

  lines.push(
    "## Reading this",
    "",
    "The routed set is the first five the router returns, which is what",
    "`find_capabilities` registers. The router was asked for six so the first",
    "excluded score is visible; a tie at the cut means the fifth and sixth",
    "scores were equal and codepoint order of the name decided what was",
    "published. Rank is within those six; a capability the router never",
    "returned has none.",
    "",
    "Schema bytes are what the routed set would register, serialized the way",
    "`ToolSurfaceManager` counts them, without the four bootstrap tools.",
    "",
    "Prompt overlap is the share of a task's content tokens that appear in",
    "the expected capability's name, intents, keywords, and domain. The task",
    "set was authored from names and descriptions, not routing metadata, and",
    "the loader refuses any task above the stated threshold, so this row is",
    "the leakage rule enforced by a number.",
    "",
  );
  return lines.join("\n");
}
