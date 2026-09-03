import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyTranscript, ARMS, CELLS, probeTask } from "./arms.mjs";
import { buildCatalog } from "./catalog.mjs";
import { computeMetrics } from "./metrics.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { loadTasks, loadTranscript } from "./load.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const ARM_NAMES = Object.keys(ARMS);

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  if (!existsSync(dist)) {
    console.error(
      "packages/webmcp/dist is missing. Run `pnpm --filter @agentdesksdk/webmcp build` first;\n" +
        "the eval measures the published surface, not the source tree.",
    );
    process.exit(1);
  }
  const sdk = await import(pathToFileURL(dist).href);

  const tasksPath = resolve(repoRoot, argValue("--tasks", join(here, "tasks", "v2.tasks.jsonl")));
  const tasks = loadTasks(tasksPath, { repoRoot });
  const transcript = loadTranscript(argValue("--transcript", undefined), tasks, { repoRoot, armNames: ARM_NAMES });
  const runId = argValue("--run-id", `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const outDir = resolve(repoRoot, argValue("--out", join(here, "runs", runId)));
  mkdirSync(outDir, { recursive: true });

  // Every arm under every shape. Each cell runs every task on its own fresh
  // runtime; shape is applied to the recorded result, so the runtime's
  // behaviour in a cell is the arm's and nothing else.
  const cells = {};
  for (const [key, cell] of Object.entries(CELLS)) {
    const records = [];
    for (const task of tasks) {
      // A fresh catalog per task, so one task's writes cannot decide the
      // next task's availability and quietly change what is being measured.
      const { capabilities } = buildCatalog(sdk.defineCapability, sdk.receipt, sdk.unavailable);
      const probed = await probeTask({
        createAgentDeskRuntime: sdk.createAgentDeskRuntime,
        capabilities,
        task,
        arm: cell.arm,
        shape: cell.shape,
        runId,
      });
      records.push(applyTranscript(probed, transcript.get(`${cell.arm}:${cell.shape}:${task.id}`)));
    }
    writeFileSync(
      join(outDir, `records.${key}.jsonl`),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    cells[key] = { ...cell, metrics: computeMetrics(records) };
  }

  const report = buildReport({
    runId,
    at: new Date().toISOString(),
    taskSetPath: relative(repoRoot, tasksPath).split("\\").join("/"),
    taskCount: tasks.length,
    cells,
  });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report), "utf8");

  console.log(renderMarkdown(report));
  console.log(`raw records and report written to ${relative(repoRoot, outDir).split("\\").join("/")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
