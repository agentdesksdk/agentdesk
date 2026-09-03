import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRoutingCatalog, generateCatalog } from "../routing/catalog.mjs";
import { loadRoutingRecords, loadRoutingTasks } from "../routing/load.mjs";
import { computeRoutingMetrics, failingTasks } from "../routing/metrics.mjs";
import { definitionBytes, probeRouting } from "../routing/probe.mjs";
import { buildRoutingReport, renderRoutingMarkdown } from "../routing/report.mjs";
import { ROUTED_BUDGET, ROUTING_RECORD_SCHEMA_VERSION, STRATEGIES } from "../routing/schema.mjs";

/**
 * Every figure in the routing report is a pure function of its records, and
 * the committed reference rebuilds byte for byte. The metrics need no
 * model: whether the expected capability is in the routed set, its rank,
 * the size of the set, the schema bytes it would register, and whether the
 * cut fell on a tie, which is the fragility #19 recorded.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;
const referenceDir = join(evals, "runs", "routing-reference");
const stripCr = (text) => text.split(String.fromCharCode(13)).join("");

function record({ strategy = "deterministic", taskId = "t", expected = "refund_shipping_fee", routed, rank, tie = false, bytes = 1000, overlap = 0.2 } = {}) {
  const names = routed ?? ["refund_shipping_fee", "refund_order", "cancel_order", "list_orders", "export_orders"];
  const scores = names.map((_, i) => 10 - i);
  const cutScore = scores[ROUTED_BUDGET - 1] ?? null;
  const nextScore = tie ? cutScore : cutScore === null ? null : cutScore - 1;
  const found = names.indexOf(expected);
  return {
    schemaVersion: ROUTING_RECORD_SCHEMA_VERSION,
    runId: "p",
    strategy,
    taskId,
    prompt: "messy phrasing",
    expected,
    overlap: { ratio: overlap, matched: [], threshold: 0.5 },
    observed: {
      budget: ROUTED_BUDGET,
      routed: names.slice(0, ROUTED_BUDGET).map((name, i) => ({ name, score: scores[i] })),
      rank: rank === undefined ? (found === -1 ? null : found + 1) : rank,
      hit: rank === undefined ? found !== -1 && found < ROUTED_BUDGET : rank !== null && rank <= ROUTED_BUDGET,
      routedCount: Math.min(names.length, ROUTED_BUDGET),
      schemaBytes: bytes,
      cutScore,
      nextScore,
      tieAtCut: tie,
    },
    notes: [],
  };
}

test("the budget is the runtime's default routed set", () => {
  assert.equal(ROUTED_BUDGET, 5, "DEFAULT_ROUTED in router.ts is 5 and is what find_capabilities registers");
  assert.deepEqual([...STRATEGIES], ["deterministic", "hybrid"]);
});

test("terminal-in-routed-set counts hits over every task, and rank averages only hits", () => {
  const hit = record({ taskId: "a" });
  const miss = record({ taskId: "b", routed: ["refund_order", "cancel_order", "list_orders", "export_orders", "hold_order"] });
  const late = record({ taskId: "c", routed: ["cancel_order", "list_orders", "refund_shipping_fee", "export_orders", "hold_order"] });
  const metrics = computeRoutingMetrics([hit, miss, late]);
  assert.equal(metrics.terminalInRoutedSet.numerator, 2);
  assert.equal(metrics.terminalInRoutedSet.denominator, 3);
  assert.equal(metrics.terminalInRoutedSet.provenance, "measured");
  assert.equal(metrics.terminalRank.denominator, 2, "rank is averaged over hits only");
  assert.equal(metrics.terminalRank.mean, 2, "ranks 1 and 3");
  assert.equal(metrics.terminalRank.max, 3);
});

test("a tie at the cut is counted when the last routed score equals the first excluded score", () => {
  const tied = record({ taskId: "a", tie: true });
  const clean = record({ taskId: "b" });
  const metrics = computeRoutingMetrics([tied, clean]);
  assert.equal(metrics.tieAtCut.numerator, 1);
  assert.equal(metrics.tieAtCut.denominator, 2);
  assert.equal(metrics.tieAtCut.value, 0.5);
});

test("routed-set size, schema bytes, and overlap are summarized as mean and max", () => {
  const small = record({ taskId: "a", routed: ["refund_shipping_fee", "refund_order"], bytes: 400, overlap: 0.1 });
  const full = record({ taskId: "b", bytes: 1200, overlap: 0.3 });
  const metrics = computeRoutingMetrics([small, full]);
  assert.equal(metrics.routedSetSize.mean, 3.5);
  assert.equal(metrics.routedSetSize.max, 5);
  assert.equal(metrics.schemaBytes.mean, 800);
  assert.equal(metrics.metadataOverlap.max, 0.3);
  assert.equal(metrics.metadataOverlap.provenance, "measured");
});

test("an empty run is unavailable everywhere, never a perfect score", () => {
  for (const [name, metric] of Object.entries(computeRoutingMetrics([]))) {
    assert.equal(metric.value, null, `${name} must be null on an empty run`);
    assert.equal(metric.provenance, "unavailable", `${name} must be unavailable on an empty run`);
  }
});

test("failing tasks are listed with what was routed instead", () => {
  const miss = record({ taskId: "b", routed: ["refund_order", "cancel_order", "list_orders", "export_orders", "hold_order"] });
  const listed = failingTasks([record({ taskId: "a" }), miss]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].taskId, "b");
  assert.equal(listed[0].expected, "refund_shipping_fee");
  assert.deepEqual(listed[0].routed, ["refund_order", "cancel_order", "list_orders", "export_orders", "hold_order"]);
});

test("the reference run exists and recomputes byte for byte from its records", () => {
  assert.ok(existsSync(join(referenceDir, "report.json")), "scripts/evals/runs/routing-reference/report.json is the committed reference");
  const published = JSON.parse(readFileSync(join(referenceDir, "report.json"), "utf8"));
  const records = Object.fromEntries(
    STRATEGIES.map((strategy) => [strategy, loadRoutingRecords(join(referenceDir, `records.${strategy}.jsonl`), { repoRoot })]),
  );
  const ids = (strategy) => records[strategy].map((r) => r.taskId).sort();
  assert.deepEqual(ids("deterministic"), ids("hybrid"), "both strategies ran the same tasks");
  const runIds = new Set(Object.values(records).flat().map((r) => r.runId));
  assert.equal(runIds.size, 1);

  const rebuilt = buildRoutingReport({
    runId: [...runIds][0],
    at: published.at,
    taskSetPath: published.taskSet.path,
    taskCount: records.deterministic.length,
    catalog: published.catalog,
    cells: Object.fromEntries(
      STRATEGIES.map((strategy) => [
        strategy,
        { strategy, metrics: computeRoutingMetrics(records[strategy]), failing: failingTasks(records[strategy]) },
      ]),
    ),
  });
  assert.equal(
    JSON.stringify(rebuilt, null, 2) + "\n",
    stripCr(readFileSync(join(referenceDir, "report.json"), "utf8")),
    "report.json is not byte for byte what its records compute",
  );
  assert.equal(
    stripCr(renderRoutingMarkdown(rebuilt)),
    stripCr(readFileSync(join(referenceDir, "report.md"), "utf8")),
    "report.md is stale against report.json",
  );
  assert.match(published.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(published.catalog.seed, 2026);
});

test("the reference report says plainly what the current scorer gets wrong", () => {
  const published = JSON.parse(readFileSync(join(referenceDir, "report.json"), "utf8"));
  const deterministic = published.cells.deterministic;
  assert.ok(deterministic.metrics.terminalInRoutedSet.value < 1, "a scorer that gets every messy task right needs no replacement");
  assert.ok(deterministic.failing.length > 0, "the failing tasks are listed");
  const markdown = stripCr(readFileSync(join(referenceDir, "report.md"), "utf8"));
  assert.match(markdown, /## What the current scorer gets wrong/);
  for (const failure of deterministic.failing) {
    assert.ok(markdown.includes(failure.taskId), `${failure.taskId} is not listed in the report`);
  }
});

test(
  "the hierarchical probe reports schema bytes the way the autonomous runtime measures them, under the same budget",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const { capabilities, specs } = buildRoutingCatalog(sdk.defineCapability, 2026);
    const { specs: plain } = generateCatalog(2026);
    assert.equal(plain.length, specs.length);
    const [task] = loadRoutingTasks(join(evals, "routing", "tasks", "routing.v1.tasks.jsonl"), specs, {
      repoRoot,
      tokenize: sdk.tokenize,
    });
    const runtimeStrategy = {
      name: "custom:runtime-hierarchical",
      kind: "custom",
      path: "@agentdesksdk/webmcp#hierarchicalScorer",
      strategy: {
        kind: "custom",
        scorer: sdk.hierarchicalScorer,
        onFailure: "refuse",
      },
    };
    const probed = await probeRouting({
      routeTask: sdk.routeTask,
      capabilities,
      task,
      strategy: runtimeStrategy,
      runId: "t",
    });
    assert.equal(probed.strategy, "custom:runtime-hierarchical");
    assert.equal(probed.observed.budget, ROUTED_BUDGET);
    assert.ok(probed.observed.routed.length <= ROUTED_BUDGET);
    assert.equal(typeof probed.observed.tieAtCut, "boolean");

    // Bytes are the runtime's: a routed runtime over the same catalog
    // registers the bootstrap tools plus the routed set, so its schemaBytes
    // less the bootstrap-only figure is what the routed set costs.
    const byName = new Map(capabilities.map((c) => [c.name, c]));
    const bootstrapOnly = sdk.createAgentDeskRuntime({ capabilities: [], registerTool: async () => {}, exposure: "routed" });
    await bootstrapOnly.start();
    const bootstrapBytes = bootstrapOnly.getSnapshot().schemaBytes;
    await bootstrapOnly.stop();

    const runtime = sdk.createAgentDeskRuntime({ capabilities, registerTool: async () => {}, exposure: "routed" });
    await runtime.start();
    await runtime.routeTask(task.prompt);
    const snapshot = runtime.getSnapshot();
    const routedByRuntime = snapshot.nativeTools.filter((name) => byName.has(name)).sort();
    await runtime.stop();

    assert.deepEqual(probed.observed.routed.map((m) => m.name).sort(), routedByRuntime, "the probe routes what the runtime registers");
    const summed = routedByRuntime.reduce((sum, name) => sum + definitionBytes(byName.get(name)), 0);
    assert.equal(summed, snapshot.schemaBytes - bootstrapBytes, "definitionBytes must serialize exactly as ToolSurfaceManager does");
    assert.equal(probed.observed.schemaBytes, summed);
  },
);
