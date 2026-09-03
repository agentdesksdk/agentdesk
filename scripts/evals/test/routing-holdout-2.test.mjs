import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateCatalog, buildRoutingCatalog } from "../routing/catalog.mjs";
import { loadRoutingRecords, loadRoutingTasks } from "../routing/load.mjs";
import { OVERLAP_THRESHOLD } from "../routing/overlap.mjs";
import { computeRoutingMetrics, failingTasks } from "../routing/metrics.mjs";
import { buildRoutingReport, renderRoutingMarkdown } from "../routing/report.mjs";
import nearTieOne, { NEAR_TIE, name as scorerName, tiedDomains } from "../routing/scorers/hierarchical-near-tie-1.mjs";

/**
 * The second held-out set. A second seed's catalog, phrasings authored
 * after the hierarchical scorer shipped and without its metadata, and
 * the scorer run with the near-tie at its default and at 1.0, so the
 * verdict on 2.2 rests on a set it was never tuned against, under a rule
 * written before the run.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;
const SEED = 7;
const TASKS = join(evals, "routing", "tasks", "routing.v2.tasks.jsonl");
const DEFAULT_RUN = join(evals, "runs", "routing-holdout-2");
const ONE_RUN = join(evals, "runs", "routing-holdout-2-near-tie-1");
const stripCr = (text) => text.split(String.fromCharCode(13)).join("");

test("the second seed is a different catalog of the same size and domains", () => {
  const first = generateCatalog(2026);
  const second = generateCatalog(SEED);
  assert.equal(second.specs.length, first.specs.length);
  assert.deepEqual(second.domains, first.domains);
  const shared = second.specs.filter((s) => first.specs.some((f) => f.name === s.name)).length;
  assert.ok(shared < second.specs.length, "a second seed samples a different catalog");
  assert.ok(shared > 0, "from the same tables, so some names recur");
});

test("the second held-out set loads under the threshold against the second seed, and reaches every domain", () => {
  const { specs, domains } = generateCatalog(SEED);
  const tokenize = sdk?.tokenize ?? ((text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tasks = loadRoutingTasks(TASKS, specs, { repoRoot, tokenize });
  assert.equal(tasks.length, 55, "the same count as the first set, so the rates compare");
  const byName = new Map(specs.map((s) => [s.name, s]));
  const reached = new Set(tasks.map((t) => byName.get(t.expected).domain));
  assert.deepEqual([...reached].sort(), [...domains].sort(), "at least one task per domain");
  for (const t of tasks) {
    assert.ok(t.overlap.ratio <= OVERLAP_THRESHOLD, `${t.id} overlaps ${t.overlap.ratio}`);
  }
  const first = readFileSync(join(evals, "routing", "tasks", "routing.v1.tasks.jsonl"), "utf8");
  for (const t of tasks) {
    assert.ok(!first.includes(JSON.stringify(t.prompt)), `${t.id} repeats a prompt from the first set`);
  }
});

test("the 1.0 variant keeps only the domains that tie the top one exactly", () => {
  assert.equal(NEAR_TIE, 0.75, "the default the SDK ships, restated here so the ablation names what it changes");
  const ranked = [
    { domain: "billing", score: 2.4 },
    { domain: "payments", score: 2.4 },
    { domain: "orders", score: 1.9 },
  ];
  assert.deepEqual(tiedDomains(ranked, 1.0), ["billing", "payments"], "an exact tie is kept at 1.0");
  assert.deepEqual(tiedDomains(ranked, NEAR_TIE), ["billing", "payments"], "and at the default too");
  assert.deepEqual(tiedDomains([{ domain: "billing", score: 2.4 }, { domain: "orders", score: 1.9 }], 1.0), ["billing"]);
  assert.deepEqual(tiedDomains([{ domain: "billing", score: 2.4 }, { domain: "orders", score: 1.9 }], NEAR_TIE), ["billing", "orders"], "a near tie is kept at the default");
  assert.deepEqual(tiedDomains([], 1.0), []);
  assert.equal(scorerName, "hierarchical-near-tie-1.0");
});

test(
  "the 1.0 variant is the SDK's hierarchical scorer over the top domain, and agrees with it when no second domain nearly ties",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const { capabilities, specs } = buildRoutingCatalog(sdk.defineCapability, SEED);
    const tasks = loadRoutingTasks(TASKS, specs, { repoRoot, tokenize: sdk.tokenize });
    const request = (task) => ({ query: task.prompt, context: { route: "/", state: {} } });
    // Whether the default would keep a second domain is a fact about the
    // catalog's domain ranking, not about which members reached the top
    // six, so it is read off the SDK's own hierarchy.
    const hierarchy = sdk.catalogHierarchy(capabilities);
    let compared = 0;
    let differed = 0;
    for (const task of tasks) {
      const ours = await sdk.routeTask(capabilities, request(task), { kind: "custom", scorer: nearTieOne, onFailure: "refuse" });
      const theirs = await sdk.routeTask(capabilities, request(task), { kind: "custom", scorer: sdk.hierarchicalScorer, onFailure: "refuse" });
      assert.equal(ours.ok, true, `${task.id}: the variant refused`);
      assert.equal(theirs.ok, true);
      const names = (r) => r.matches.map((m) => m.capability.name);
      const ranked = hierarchy.rankDomains(task.prompt, () => true);
      if (tiedDomains(ranked, NEAR_TIE).length === tiedDomains(ranked, 1.0).length) {
        // No second domain nearly ties, so 0.75 and 1.0 keep the same
        // domains and the variant is the SDK scorer, byte for byte.
        compared += 1;
        assert.deepEqual(names(ours), names(theirs), `${task.id}: one domain either way, yet the rankings differ`);
      } else {
        differed += 1;
        for (const match of ours.matches) {
          assert.ok(tiedDomains(ranked, 1.0).includes(match.capability.domain), `${task.id}: the variant routed outside the tied domains`);
        }
      }
    }
    assert.ok(compared > 0, "some task keeps one domain at both thresholds");
    assert.ok(differed > 0, "some task keeps a second domain at the default, or the ablation measures nothing");
  },
);

test("both held-out runs exist, recompute byte for byte, and share the deterministic cell", () => {
  for (const dir of [DEFAULT_RUN, ONE_RUN]) {
    assert.ok(existsSync(join(dir, "report.json")), `${dir} is a committed run`);
  }
  const rebuild = (dir) => {
    const published = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    const cells = {};
    for (const [key, cell] of Object.entries(published.cells)) {
      const file = join(dir, `records.${key.replace(/[^A-Za-z0-9_.-]/g, "-")}.jsonl`);
      const records = loadRoutingRecords(file, { repoRoot });
      cells[key] = {
        strategy: key,
        ...(cell.scorer !== undefined ? { scorer: cell.scorer } : {}),
        metrics: computeRoutingMetrics(records),
        failing: failingTasks(records),
      };
    }
    const rebuilt = buildRoutingReport({
      runId: published.runId,
      at: published.at,
      taskSetPath: published.taskSet.path,
      taskCount: published.taskSet.taskCount,
      catalog: published.catalog,
      cells,
    });
    assert.equal(JSON.stringify(rebuilt, null, 2) + "\n", stripCr(readFileSync(join(dir, "report.json"), "utf8")), `${dir}/report.json is not what its records compute`);
    assert.equal(stripCr(renderRoutingMarkdown(rebuilt)), stripCr(readFileSync(join(dir, "report.md"), "utf8")), `${dir}/report.md is stale`);
    return published;
  };
  const defaults = rebuild(DEFAULT_RUN);
  const one = rebuild(ONE_RUN);
  assert.equal(defaults.catalog.seed, SEED);
  assert.equal(one.catalog.seed, SEED);
  assert.equal(defaults.taskSet.path, "scripts/evals/routing/tasks/routing.v2.tasks.jsonl");
  assert.deepEqual(Object.keys(defaults.cells), ["deterministic", "hybrid", "custom:hierarchical"]);
  assert.deepEqual(Object.keys(one.cells), ["deterministic", "custom:hierarchical-near-tie-1.0"]);
  assert.deepEqual(
    defaults.cells.deterministic.metrics,
    one.cells.deterministic.metrics,
    "the deterministic cell is the same run twice, so the two reports describe one catalog and one task set",
  );
});
