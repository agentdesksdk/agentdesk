import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARMS, CELLS } from "../arms.mjs";
import { computeMetrics } from "../metrics.mjs";
import { buildReport, renderMarkdown } from "../report.mjs";
import { loadRecords, loadTranscript } from "../load.mjs";
import { parseTask } from "../schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const jsonl = (path) =>
  readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

const TASK_SET = "scripts/evals/tasks/v2.tasks.jsonl";
const tasks = jsonl(join(evals, "tasks", "v2.tasks.jsonl")).map((t) => parseTask(t, TASK_SET));
const refusal = tasks.find((t) => t.unsafe);
const acting = tasks.find((t) => !t.unsafe);

function record(arm, task, selectedTools) {
  return {
    schemaVersion: 2, runId: "p", arm, taskId: task.id,
    expectedTools: [...task.expectedTools[arm]], expectedArguments: {},
    consequential: task.consequential, unsafe: task.unsafe, terminalTool: task.terminalTool,
    events: [], notes: [],
    observed: {
      decisionSource: "transcript", selectedTools, arguments: {}, completed: !task.unsafe,
      approvalRequested: false, executedWithoutApproval: false,
      dispatched: !task.unsafe, blocked: task.unsafe, visibleToolCount: 1, schemaBytes: 1, peakVisibleToolCount: 1, peakSchemaBytes: 1,
    },
  };
}

function withTranscript(name, entries, assertion) {
  const path = join(evals, "test", name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  try {
    assertion(path);
  } finally {
    rmSync(path, { force: true });
  }
}

test("correct refusal is not scored as a terminal-tool miss", () => {
  for (const arm of Object.keys(ARMS)) {
    const correct = record(arm, refusal, [...refusal.expectedTools[arm]]);
    const metric = computeMetrics([correct]).terminalToolAccuracy;
    assert.equal(metric.value, null, `${arm} was scored on a task whose correct outcome is refusing to act`);
    assert.equal(metric.provenance, "unavailable");
  }
});

test("terminal-tool accuracy still scores tasks that should act", () => {
  const hit = record("agentdesk", acting, [...acting.expectedTools.agentdesk]);
  const miss = record("agentdesk", acting, ["find_capabilities", "cancel_order"]);
  assert.equal(computeMetrics([hit]).terminalToolAccuracy.value, 1);
  assert.equal(computeMetrics([miss]).terminalToolAccuracy.value, 0);
});

test("a transcript entry with no arm is refused, not silently dropped", () => {
  withTranscript("tmp-noarm.jsonl", [{ taskId: acting.id, shape: "structured", selectedTools: [], arguments: {}, completed: false }], (p) =>
    assert.throws(() => loadTranscript(p, tasks, { repoRoot: process.cwd() }), /arm/),
  );
});

test("a transcript entry for an unknown task is refused", () => {
  withTranscript(
    "tmp-unknown.jsonl",
    [{ arm: "agentdesk", shape: "structured", taskId: "no-such-task", selectedTools: [], arguments: {}, completed: false }],
    (p) => assert.throws(() => loadTranscript(p, tasks, { repoRoot: process.cwd() }), /no-such-task/),
  );
});

test("a transcript entry for an unknown arm is refused", () => {
  withTranscript(
    "tmp-badarm.jsonl",
    [{ arm: "control", shape: "structured", taskId: acting.id, selectedTools: [], arguments: {}, completed: false }],
    (p) => assert.throws(() => loadTranscript(p, tasks, { repoRoot: process.cwd() }), /control/),
  );
});

test("duplicate entries for one arm and task are refused, not last-write-wins", () => {
  withTranscript(
    "tmp-dupe.jsonl",
    [
      { arm: "agentdesk", shape: "structured", taskId: acting.id, selectedTools: ["a"], arguments: {}, completed: true },
      { arm: "agentdesk", shape: "structured", taskId: acting.id, selectedTools: ["b"], arguments: {}, completed: false },
    ],
    (p) => assert.throws(() => loadTranscript(p, tasks, { repoRoot: process.cwd() }), /duplicate/i),
  );
});

test("a well-formed transcript still loads", () => {
  withTranscript(
    "tmp-good.jsonl",
    [{ arm: "agentdesk", shape: "structured", taskId: acting.id, selectedTools: ["find_capabilities"], arguments: {}, completed: true }],
    (p) => {
      const loaded = loadTranscript(p, tasks, { repoRoot: process.cwd() });
      assert.equal(loaded.size, 1);
      assert.ok(loaded.has(`agentdesk:structured:${acting.id}`));
    },
  );
});

test("report metadata is checked against its sources, not against itself", () => {
  const reference = Object.fromEntries(
    Object.keys(CELLS).map((key) => [key, loadRecords(join(evals, "runs", "reference", `records.${key}.jsonl`), { repoRoot })]),
  );
  const published = JSON.parse(readFileSync(join(evals, "runs", "reference", "report.json"), "utf8"));

  // Every derivable field comes from the fixtures, the records, and the
  // canonical cell table. Taking them from the artifact under test is what let
  // a task count of 999 and a label of "AgentDesk always wins" survive.
  // One run id, asserted across every record rather than sampled from the
  // first. Sampling let a record claiming a different run pass unnoticed,
  // which would mean the report described two runs as one.
  const runIds = new Set(Object.values(reference).flat().map((r) => r.runId));
  assert.equal(runIds.size, 1, `records disagree on their run id: ${[...runIds].join(", ")}`);
  const [runId] = [...runIds];
  assert.ok(typeof runId === "string" && runId.length > 0, "run id must be a non-empty string");

  const rebuilt = buildReport({
    runId,
    at: published.at,
    taskSetPath: TASK_SET,
    taskCount: tasks.length,
    cells: Object.fromEntries(
      Object.keys(CELLS).map((key) => [key, { ...CELLS[key], metrics: computeMetrics(reference[key]) }]),
    ),
  });
  assert.deepEqual(rebuilt, published, "report.json disagrees with its own sources");
  assert.match(published.at, /^\d{4}-\d{2}-\d{2}T/, "at is the one field nothing can derive, so it is shape-checked");

  const stripCr = (t) => t.split(String.fromCharCode(13)).join("");
  assert.equal(
    stripCr(renderMarkdown(rebuilt)),
    stripCr(readFileSync(join(evals, "runs", "reference", "report.md"), "utf8")),
    "report.md is stale against what its sources compute",
  );
});
