import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyTranscript, ARMS, parseTranscriptEntry, probeTask } from "./arms.mjs";
import { buildCatalog } from "./catalog.mjs";
import { computeMetrics } from "./metrics.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { parseTask } from "./schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const ARM_NAMES = Object.keys(ARMS);
const NEWLINE = String.fromCharCode(10);

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

/**
 * The transcript is external input, so the whole file is validated against
 * the loaded task set before any of it is used. Building the lookup from raw
 * fields first meant an entry naming no arm, or an unknown task, simply never
 * matched and vanished, and a duplicate quietly replaced the first. A dropped
 * entry is indistinguishable from a run that never had one.
 */
export function loadTranscript(path, tasks) {
  if (path === undefined) return new Map();
  if (!existsSync(path)) {
    throw new Error(`transcript not found: ${path}`);
  }
  const known = new Set(tasks.map((t) => t.id));
  const source = relative(repoRoot, path);
  const byKey = new Map();

  readFileSync(path, "utf8").split(NEWLINE).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "") return;
    const at = `${source} line ${index + 1}`;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new SyntaxError(`${at} is not valid JSON: ${err.message}`);
    }
    const entry = parseTranscriptEntry(raw, at);
    if (typeof entry.arm !== "string") {
      throw new TypeError(`${at} must name an arm, one of ${ARM_NAMES.join(", ")}`);
    }
    if (!ARM_NAMES.includes(entry.arm)) {
      throw new TypeError(`${at} names arm ${JSON.stringify(entry.arm)}, not one of ${ARM_NAMES.join(", ")}`);
    }
    if (!known.has(entry.taskId)) {
      throw new TypeError(`${at} names task ${JSON.stringify(entry.taskId)}, which is not in the task set`);
    }
    const key = `${entry.arm}:${entry.taskId}`;
    if (byKey.has(key)) {
      throw new TypeError(`${at} is a duplicate entry for ${key}`);
    }
    byKey.set(key, entry);
  });
  return byKey;
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

  const tasksPath = resolve(repoRoot, argValue("--tasks", join(here, "tasks", "v2.tasks.jsonl")));
  const tasks = loadTasks(tasksPath);
  const transcript = loadTranscript(argValue("--transcript", undefined), tasks);
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
