import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeMetrics } from "../metrics.mjs";
import { parseTask, RECORD_SCHEMA_VERSION } from "../schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const readJsonl = (p) =>
  readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const tasks = readJsonl(join(evals, "tasks", "v1.tasks.jsonl"));
const reference = Object.fromEntries(
  ["baseline", "agentdesk"].map((arm) => [arm, readJsonl(join(evals, "runs", "reference", `records.${arm}.jsonl`))]),
);
const report = JSON.parse(readFileSync(join(evals, "runs", "reference", "report.json"), "utf8"));

test("every shipped task fixture parses", () => {
  for (const raw of tasks) {
    assert.doesNotThrow(() => parseTask(raw, "v1.tasks.jsonl"));
  }
});

test("task ids are unique", () => {
  const ids = tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("both arms ran the identical task set", () => {
  const ids = (arm) => reference[arm].map((r) => r.taskId).sort();
  assert.deepEqual(ids("baseline"), ids("agentdesk"));
  assert.deepEqual(ids("baseline"), tasks.map((t) => t.id).sort());
});

test("every record carries its schema version and its expectations", () => {
  for (const arm of Object.keys(reference)) {
    for (const record of reference[arm]) {
      assert.equal(record.schemaVersion, RECORD_SCHEMA_VERSION);
      assert.ok(Array.isArray(record.expectedTools), `${record.taskId} lost expectedTools`);
      assert.equal(typeof record.consequential, "boolean");
      assert.ok(Array.isArray(record.events), `${record.taskId} lost its trace events`);
    }
  }
});

test("the published report is recomputable from the raw records", () => {
  for (const arm of Object.keys(reference)) {
    const recomputed = computeMetrics(reference[arm]);
    for (const [name, metric] of Object.entries(recomputed)) {
      assert.deepEqual(
        report.arms[arm].metrics[name].value,
        metric.value,
        `${arm}.${name} in report.json does not match its records`,
      );
    }
  }
});

test("the reference run claims no model results", () => {
  for (const arm of Object.keys(reference)) {
    for (const name of ["toolSelectionAccuracy", "argumentAccuracy", "taskCompletion"]) {
      assert.equal(report.arms[arm].metrics[name].value, null);
      assert.equal(report.arms[arm].metrics[name].provenance, "unavailable");
    }
  }
});

test("routing shrinks the surface without changing governance", () => {
  const b = report.arms.baseline.metrics;
  const a = report.arms.agentdesk.metrics;
  assert.ok(a.visibleToolCount.value < b.visibleToolCount.value, "routed arm should expose fewer tools");
  assert.ok(a.registeredSchemaBytes.value < b.registeredSchemaBytes.value, "routed arm should register fewer bytes");
  assert.equal(a.approvalCompliance.value, b.approvalCompliance.value, "exposure must not change approval behaviour");
  assert.equal(a.unsafeExecutionsBlocked.value, b.unsafeExecutionsBlocked.value, "exposure must not change blocking");
});
