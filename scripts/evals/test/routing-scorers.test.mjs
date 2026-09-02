import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRoutingCatalog } from "../routing/catalog.mjs";
import { loadRoutingRecords, loadRoutingTasks } from "../routing/load.mjs";
import { probeRouting } from "../routing/probe.mjs";
import { buildRoutingReport, renderRoutingMarkdown } from "../routing/report.mjs";
import { computeRoutingMetrics, failingTasks } from "../routing/metrics.mjs";
import { parseRoutingRecord, ROUTING_RECORD_SCHEMA_VERSION } from "../routing/schema.mjs";
import {
  BUILTIN_STRATEGIES,
  loadScorer,
  recordsFileKey,
  resolveStrategies,
  resolveStrategy,
} from "../routing/strategies.mjs";

/**
 * The same catalog and the same 55 tasks are the acceptance test for the
 * hierarchical catalog 2.2 builds. The runner therefore takes a scorer by
 * name from the SDK's exported strategies, and a custom one loaded from a
 * path, so 2.2's PR can report its cells against this reference without
 * touching the eval. A custom scorer that fails refuses the run; it never
 * degrades to the deterministic scorer under a custom label.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;

function withScorerModule(name, source, assertion) {
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-scorer-"));
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, source, "utf8");
  return Promise.resolve(assertion(path, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const ORACLE = (expected) => `
// Ranks the expected capability first and nothing else. A scorer that
// knows the answer, so the harness's own plumbing is what is under test.
export default function oracle(candidates) {
  return candidates
    .filter((c) => c.name === ${JSON.stringify(expected)})
    .map((c) => ({ name: c.name, score: 1, reasons: ["oracle"] }));
}
`;

test("a built-in strategy resolves by name to the SDK's strategy object", () => {
  assert.deepEqual([...BUILTIN_STRATEGIES], ["deterministic", "hybrid"]);
  for (const name of BUILTIN_STRATEGIES) {
    const resolved = resolveStrategy(name);
    assert.equal(resolved.name, name);
    assert.equal(resolved.kind, name);
    assert.deepEqual(resolved.strategy, { kind: name });
  }
});

test("an unknown strategy name is refused, naming the built-ins and the custom flag", () => {
  assert.throws(
    () => resolveStrategy("semantic"),
    (err) => {
      assert.match(err.message, /semantic/);
      assert.match(err.message, /deterministic/);
      assert.match(err.message, /hybrid/);
      assert.match(err.message, /--scorer/);
      return true;
    },
  );
});

test("a custom scorer loads from a path as a refusing custom strategy named after its file", async () => {
  await withScorerModule("hierarchical", ORACLE("get_order"), async (path) => {
    const loaded = await loadScorer(path, { repoRoot });
    assert.equal(loaded.name, "custom:hierarchical");
    assert.equal(loaded.kind, "custom");
    assert.equal(loaded.strategy.kind, "custom");
    assert.equal(typeof loaded.strategy.scorer, "function");
    assert.equal(loaded.strategy.onFailure, "refuse", "a broken scorer must refuse, never degrade to a deterministic number under a custom label");
    assert.equal(typeof loaded.path, "string");
  });
});

test("a scorer module may name itself, and may export `scorer` instead of default", async () => {
  const source = `export const name = "tree-v2";\nexport const scorer = (candidates) => candidates.map((c) => ({ name: c.name, score: 1 }));\n`;
  await withScorerModule("whatever", source, async (path) => {
    const loaded = await loadScorer(path, { repoRoot });
    assert.equal(loaded.name, "custom:tree-v2");
    assert.equal(typeof loaded.strategy.scorer, "function");
  });
});

test("a module with nothing callable to score with is refused, naming the path", async () => {
  await withScorerModule("empty", "export const answer = 42;\n", async (path) => {
    await assert.rejects(() => loadScorer(path, { repoRoot }), (err) => {
      assert.match(err.message, /empty\.mjs/);
      assert.match(err.message, /scorer/i);
      return true;
    });
  });
  await assert.rejects(() => loadScorer(join(evals, "routing", "no-such-scorer.mjs"), { repoRoot }), /no-such-scorer/);
});

test("resolveStrategies defaults to both built-ins and appends the custom scorer when given", async () => {
  const defaults = await resolveStrategies({ repoRoot });
  assert.deepEqual(defaults.map((s) => s.name), ["deterministic", "hybrid"]);
  const one = await resolveStrategies({ names: ["hybrid"], repoRoot });
  assert.deepEqual(one.map((s) => s.name), ["hybrid"]);
  await withScorerModule("mine", ORACLE("get_order"), async (path) => {
    const withCustom = await resolveStrategies({ names: ["deterministic"], scorerPath: path, repoRoot });
    assert.deepEqual(withCustom.map((s) => s.name), ["deterministic", "custom:mine"]);
  });
  await assert.rejects(() => resolveStrategies({ names: ["deterministic", "deterministic"], repoRoot }), /twice|duplicate/i);
});

test("a cell name becomes a file-safe records name", () => {
  assert.equal(recordsFileKey("deterministic"), "deterministic");
  assert.equal(recordsFileKey("custom:hierarchical"), "custom-hierarchical", "a colon is not a Windows file name");
  assert.doesNotMatch(recordsFileKey("custom:a/b\\c"), /[/\\:]/);
});

test("a record under a custom strategy parses, and a bare unknown strategy does not", () => {
  const record = {
    schemaVersion: ROUTING_RECORD_SCHEMA_VERSION, runId: "p", strategy: "custom:hierarchical", taskId: "t",
    prompt: "x", expected: "get_order", overlap: { ratio: 0.1, matched: [], threshold: 0.5 },
    observed: { budget: 5, routed: [{ name: "get_order", score: 1 }], rank: 1, hit: true, routedCount: 1, schemaBytes: 10, cutScore: null, nextScore: null, tieAtCut: false },
    notes: [],
  };
  assert.doesNotThrow(() => parseRoutingRecord(record, "t"));
  assert.throws(() => parseRoutingRecord({ ...record, strategy: "semantic" }, "t"), /strategy/);
});

test("the report labels a custom cell as external and lists its failures beside the built-ins", () => {
  const record = (strategy, hit) => ({
    schemaVersion: ROUTING_RECORD_SCHEMA_VERSION, runId: "p", strategy, taskId: "t", prompt: "x", expected: "get_order",
    overlap: { ratio: 0.1, matched: [], threshold: 0.5 },
    observed: { budget: 5, routed: hit ? [{ name: "get_order", score: 1 }] : [{ name: "list_order", score: 1 }], rank: hit ? 1 : null, hit, routedCount: 1, schemaBytes: 10, cutScore: null, nextScore: null, tieAtCut: false },
    notes: [],
  });
  const cells = {};
  for (const [strategy, hit] of [["deterministic", false], ["custom:hierarchical", true]]) {
    const records = [record(strategy, hit)];
    cells[strategy] = { strategy, metrics: computeRoutingMetrics(records), failing: failingTasks(records) };
  }
  const report = buildRoutingReport({ runId: "p", at: "2026-09-03T00:00:00.000Z", taskSetPath: "t", taskCount: 1, catalog: { seed: 1, size: 1, domains: ["orders"] }, cells });
  const markdown = renderRoutingMarkdown(report);
  const header = markdown.split("\n").find((l) => l.startsWith("| Metric |"));
  assert.match(header, /Custom scorer/);
  assert.match(header, /hierarchical/);
  assert.match(markdown, /### Custom scorer[^\n]*hierarchical/);
  assert.equal(report.cells["custom:hierarchical"].metrics.terminalInRoutedSet.value, 1);
});

test(
  "the probe scores through a custom scorer and reports it as externally scored",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const { capabilities, specs } = buildRoutingCatalog(sdk.defineCapability, 2026);
    const [task] = loadRoutingTasks(join(evals, "routing", "tasks", "routing.v1.tasks.jsonl"), specs, { repoRoot, tokenize: sdk.tokenize });
    await withScorerModule("oracle", ORACLE(task.expected), async (path) => {
      const strategy = await loadScorer(path, { repoRoot });
      const record = await probeRouting({ routeTask: sdk.routeTask, capabilities, task, strategy, runId: "t" });
      assert.equal(record.strategy, "custom:oracle");
      assert.equal(record.observed.scoredExternally, true);
      assert.equal(record.observed.hit, true);
      assert.equal(record.observed.rank, 1);
      assert.deepEqual(record.scorer, { kind: "custom", path: strategy.path });
    });
    // The built-ins still take a bare name.
    const plain = await probeRouting({ routeTask: sdk.routeTask, capabilities, task, strategy: "deterministic", runId: "t" });
    assert.equal(plain.strategy, "deterministic");
    assert.equal(plain.observed.scoredExternally, false);
    assert.equal(plain.scorer, undefined, "a built-in needs no scorer provenance beyond its name");
  },
);

test(
  "a custom scorer that returns something it was not offered refuses the run rather than degrading",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const { capabilities, specs } = buildRoutingCatalog(sdk.defineCapability, 2026);
    const [task] = loadRoutingTasks(join(evals, "routing", "tasks", "routing.v1.tasks.jsonl"), specs, { repoRoot, tokenize: sdk.tokenize });
    const source = `export default () => [{ name: "not_a_capability", score: 1 }];\n`;
    await withScorerModule("liar", source, async (path) => {
      const strategy = await loadScorer(path, { repoRoot });
      await assert.rejects(
        () => probeRouting({ routeTask: sdk.routeTask, capabilities, task, strategy, runId: "t" }),
        (err) => {
          assert.match(err.message, /custom:liar/);
          assert.match(err.message, /not offered|refused/);
          return true;
        },
      );
    });
  },
);

test(
  "the CLI takes --strategies by name and --scorer by path, and writes one cell per strategy",
  { skip: sdk ? false : "dist not built" },
  async () => {
    await withScorerModule("hierarchical", ORACLE("get_order"), async (path, dir) => {
      const out = join(dir, "run");
      const result = spawnSync(
        process.execPath,
        [join(evals, "routing", "run.mjs"), "--strategies", "deterministic", "--scorer", path, "--run-id", "flag-test", "--out", out],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      assert.deepEqual(Object.keys(report.cells), ["deterministic", "custom:hierarchical"]);
      assert.equal(report.cells["custom:hierarchical"].scorer.path.endsWith("hierarchical.mjs"), true, "the report says which file scored the custom cell");
      assert.ok(existsSync(join(out, "records.deterministic.jsonl")));
      assert.ok(existsSync(join(out, "records.custom-hierarchical.jsonl")), "a colon is not a file name");
      const records = loadRoutingRecords(join(out, "records.custom-hierarchical.jsonl"), { repoRoot });
      assert.equal(records.length, report.taskSet.taskCount);
      assert.ok(records.every((r) => r.strategy === "custom:hierarchical"));
    });
    const bad = spawnSync(process.execPath, [join(evals, "routing", "run.mjs"), "--strategies", "semantic", "--out", join(tmpdir(), "never")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /semantic/);
    assert.match(bad.stderr, /deterministic/);
  },
);
