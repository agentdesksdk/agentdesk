import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRoutingCatalog } from "./catalog.mjs";
import { loadRoutingTasks } from "./load.mjs";
import { computeRoutingMetrics, failingTasks } from "./metrics.mjs";
import { probeRouting } from "./probe.mjs";
import { buildRoutingReport, renderRoutingMarkdown } from "./report.mjs";
import { recordsFileKey, resolveStrategies } from "./strategies.mjs";

/**
 * The routing stress evaluation. Run it with
 * `node scripts/evals/routing/run.mjs`; the committed reference is
 * `--run-id routing-reference --out scripts/evals/runs/routing-reference`.
 *
 * `--strategies deterministic,hybrid` names the SDK strategies to run,
 * default both. `--scorer <path>` adds a cell scored by the module at that
 * path, which must export a CapabilityScorer as default or as `scorer`;
 * the cell is named `custom:<name>` and its records are written under a
 * file-safe form of that name. A custom scorer that fails stops the run.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  if (!existsSync(dist)) {
    console.error("packages/webmcp/dist is missing. Run `pnpm --filter @agentdesk/webmcp build` first.");
    process.exit(1);
  }
  const sdk = await import(pathToFileURL(dist).href);

  const seed = Number(argValue("--seed", "2026"));
  const tasksPath = resolve(repoRoot, argValue("--tasks", join(here, "tasks", "routing.v1.tasks.jsonl")));
  const runId = argValue("--run-id", `eval-routing-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const outDir = resolve(repoRoot, argValue("--out", join(here, "..", "runs", runId)));
  const names = argValue("--strategies", undefined);
  const strategies = await resolveStrategies({
    names: names === undefined ? undefined : names.split(",").map((n) => n.trim()).filter(Boolean),
    scorerPath: argValue("--scorer", undefined),
    repoRoot,
  });

  const { capabilities, specs, domains } = buildRoutingCatalog(sdk.defineCapability, seed);
  const tasks = loadRoutingTasks(tasksPath, specs, { repoRoot, tokenize: sdk.tokenize });
  mkdirSync(outDir, { recursive: true });

  const cells = {};
  for (const strategy of strategies) {
    const records = [];
    for (const task of tasks) {
      records.push(await probeRouting({ routeTask: sdk.routeTask, capabilities, task, strategy, runId }));
    }
    writeFileSync(
      join(outDir, `records.${recordsFileKey(strategy.name)}.jsonl`),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    cells[strategy.name] = {
      strategy: strategy.name,
      ...(strategy.kind === "custom" ? { scorer: { kind: "custom", path: strategy.path } } : {}),
      metrics: computeRoutingMetrics(records),
      failing: failingTasks(records),
    };
  }

  const report = buildRoutingReport({
    runId,
    at: new Date().toISOString(),
    taskSetPath: relative(repoRoot, tasksPath).split("\\").join("/"),
    taskCount: tasks.length,
    catalog: { seed, size: specs.length, domains },
    cells,
  });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, "report.md"), renderRoutingMarkdown(report), "utf8");
  console.log(renderRoutingMarkdown(report));
  console.log(`raw records and report written to ${relative(repoRoot, outDir).split("\\").join("/")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
