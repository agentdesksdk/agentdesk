import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyTranscript, ARMS, probeTask } from "./arms.mjs";
import { buildCatalog } from "./catalog.mjs";
import { computeMetrics } from "./metrics.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { parseTask } from "./schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

function loadTasks(path) {
  const source = relative(repoRoot, path);
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new SyntaxError(`${source}: line ${index + 1} is not valid JSON: ${err.message}`);
      }
      return parseTask(parsed, source);
    });
}

function loadTranscript(path) {
  if (path === undefined) return new Map();
  if (!existsSync(path)) {
    throw new Error(`transcript not found: ${path}`);
  }
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return new Map(entries.map((e) => [`${e.arm}:${e.taskId}`, e]));
}

async function main() {
  if (!existsSync(dist)) {
    console.error(
      "packages/webmcp/dist is missing. Run `pnpm --filter @agentdesk/webmcp build` first;\n" +
        "the eval measures the published surface, not the source tree.",
    );
    process.exit(1);
  }
  const sdk = await import(pathToFileURL(dist).href);

  const tasksPath = resolve(repoRoot, argValue("--tasks", join(here, "tasks", "v1.tasks.jsonl")));
  const tasks = loadTasks(tasksPath);
  const transcript = loadTranscript(argValue("--transcript", undefined));
  const runId = argValue("--run-id", `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const outDir = resolve(repoRoot, argValue("--out", join(here, "runs", runId)));
  mkdirSync(outDir, { recursive: true });

  const arms = {};
  for (const arm of Object.keys(ARMS)) {
    const records = [];
    for (const task of tasks) {
      // A fresh catalog per task, so one task's writes cannot decide the
      // next task's availability and quietly change what is being measured.
      const { capabilities } = buildCatalog(sdk.defineCapability, sdk.receipt, sdk.unavailable);
      const probed = await probeTask({
        createAgentDeskRuntime: sdk.createAgentDeskRuntime,
        capabilities,
        task,
        arm,
        runId,
      });
      records.push(applyTranscript(probed, transcript.get(`${arm}:${task.id}`)));
    }
    writeFileSync(
      join(outDir, `records.${arm}.jsonl`),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    arms[arm] = { label: ARMS[arm].label, exposure: ARMS[arm].exposure, metrics: computeMetrics(records) };
  }

  const report = buildReport({
    runId,
    at: new Date().toISOString(),
    taskSetPath: relative(repoRoot, tasksPath).split("\\").join("/"),
    taskCount: tasks.length,
    arms,
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
