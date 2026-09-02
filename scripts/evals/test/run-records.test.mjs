import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CELLS } from "../arms.mjs";
import { loadRecords } from "../load.mjs";
import { computeMetrics } from "../metrics.mjs";
import { buildReport, renderMarkdown } from "../report.mjs";
import { parseTask, RECORD_SCHEMA_VERSION, SHAPES } from "../schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const readJsonl = (p) =>
  readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const tasks = readJsonl(join(evals, "tasks", "v2.tasks.jsonl"));
const referenceDir = join(evals, "runs", "reference");
// Through the loader, so a committed record the loader would refuse cannot
// be scored by a test that read it raw.
const reference = Object.fromEntries(
  Object.keys(CELLS).map((key) => [key, loadRecords(join(referenceDir, `records.${key}.jsonl`), { repoRoot })]),
);
const report = JSON.parse(readFileSync(join(referenceDir, "report.json"), "utf8"));
const stripCr = (text) => text.split(String.fromCharCode(13)).join("");

test("every shipped task fixture parses", () => {
  for (const raw of tasks) {
    assert.doesNotThrow(() => parseTask(raw, "v2.tasks.jsonl"));
  }
});

test("task ids are unique", () => {
  const ids = tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every cell ran the identical task set", () => {
  const expected = tasks.map((t) => t.id).sort();
  for (const [key, records] of Object.entries(reference)) {
    assert.deepEqual(records.map((r) => r.taskId).sort(), expected, `${key} drifted from the task set`);
  }
});

test("every record carries its schema version, its cell, and its expectations", () => {
  for (const [key, records] of Object.entries(reference)) {
    for (const record of records) {
      assert.equal(record.schemaVersion, RECORD_SCHEMA_VERSION);
      assert.equal(`${record.arm}.${record.shape}`, key, `${record.taskId} is filed under the wrong cell`);
      assert.ok(Array.isArray(record.expectedTools), `${record.taskId} lost expectedTools`);
      assert.equal(typeof record.consequential, "boolean");
      assert.ok(Array.isArray(record.events), `${record.taskId} lost its trace events`);
      assert.ok("result" in record.observed, `${record.taskId} did not record the result the agent received`);
    }
  }
});

test("the whole published report is recomputable from the raw records, byte for byte", () => {
  // Comparing only each metric's value let a corrupted provenance, a wrong
  // denominator, and a stale formula survive. The artifact is rebuilt and
  // compared as the exact text on disk, including the rendered Markdown,
  // because a reader believes the document, not the number behind it.
  const rebuilt = buildReport({
    runId: report.runId,
    at: report.at,
    taskSetPath: report.taskSet.path,
    taskCount: report.taskSet.taskCount,
    cells: Object.fromEntries(
      Object.keys(CELLS).map((key) => [key, { ...CELLS[key], metrics: computeMetrics(reference[key]) }]),
    ),
  });
  assert.equal(
    JSON.stringify(rebuilt, null, 2) + "\n",
    stripCr(readFileSync(join(referenceDir, "report.json"), "utf8")),
    "report.json is not byte for byte what its own records compute",
  );
  assert.equal(
    stripCr(renderMarkdown(rebuilt)),
    stripCr(readFileSync(join(referenceDir, "report.md"), "utf8")),
    "report.md is stale against report.json",
  );
});

test("the report carries four cells and each names its shape", () => {
  assert.deepEqual(Object.keys(report.cells).sort(), Object.keys(CELLS).sort());
  for (const [key, cell] of Object.entries(report.cells)) {
    assert.ok(SHAPES.includes(cell.shape), `${key} does not name its shape`);
    assert.equal(cell.arm, CELLS[key].arm);
    assert.equal(cell.exposure, CELLS[key].exposure);
  }
});

test("the reference run claims no model results in any cell", () => {
  for (const [key, cell] of Object.entries(report.cells)) {
    for (const name of ["toolSelectionAccuracy", "argumentAccuracy", "taskCompletion"]) {
      assert.equal(cell.metrics[name].value, null, `${key} ${name}`);
      assert.equal(cell.metrics[name].provenance, "unavailable", `${key} ${name}`);
    }
  }
});

test("routing shrinks the surface without changing governance, under either shape", () => {
  for (const shape of SHAPES) {
    const b = report.cells[`baseline.${shape}`].metrics;
    const a = report.cells[`agentdesk.${shape}`].metrics;
    assert.ok(a.visibleToolCount.value < b.visibleToolCount.value, `${shape}: routed arm should expose fewer tools`);
    assert.ok(a.registeredSchemaBytes.value < b.registeredSchemaBytes.value, `${shape}: routed arm should register fewer bytes`);
    assert.equal(a.approvalCompliance.value, b.approvalCompliance.value, `${shape}: exposure must not change approval behaviour`);
    assert.equal(a.unsafeExecutionsBlocked.value, b.unsafeExecutionsBlocked.value, `${shape}: exposure must not change blocking`);
  }
});

test("shape changes what the agent is handed, not the surface or the governance", () => {
  const consequentialCompletions = tasks.filter((t) => t.consequential && !t.unsafe).length;
  for (const arm of ["baseline", "agentdesk"]) {
    const bare = report.cells[`${arm}.bare`].metrics;
    const structured = report.cells[`${arm}.structured`].metrics;
    assert.equal(bare.visibleToolCount.value, structured.visibleToolCount.value, `${arm}: shape must not move the surface`);
    assert.equal(bare.registeredSchemaBytes.value, structured.registeredSchemaBytes.value, `${arm}: shape must not move schema bytes`);
    assert.equal(bare.approvalCompliance.value, structured.approvalCompliance.value, `${arm}: shape must not move approval`);
    assert.equal(bare.unsafeExecutionsBlocked.value, structured.unsafeExecutionsBlocked.value, `${arm}: shape must not move blocking`);
    assert.ok(bare.resultBytes.value < structured.resultBytes.value, `${arm}: structured evidence has to cost bytes or the axis measures nothing`);
    assert.equal(structured.evidenceCoverage.value, 1, `${arm}: every consequential completion carries a link on the structured shape`);
    assert.equal(structured.evidenceCoverage.provenance, "measured");
    assert.equal(structured.evidenceCoverage.denominator, consequentialCompletions, `${arm}: the denominator is the consequential completions`);
    assert.equal(bare.evidenceCoverage.value, 0, `${arm}: a bare result carries no evidence by construction`);
    assert.equal(bare.evidenceCoverage.provenance, "measured");
    assert.equal(bare.evidenceCoverage.denominator, consequentialCompletions);
  }
});
