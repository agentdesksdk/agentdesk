import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseTranscriptEntry } from "./arms.mjs";
import { parseTask } from "./schema.mjs";

/**
 * Import-safe. These loaders live apart from the CLI because a helper worth
 * testing must not perform an evaluation to be reached: importing the
 * transcript loader used to run both arms and write a timestamped directory.
 */
export function loadTasks(path, { repoRoot = process.cwd(), arms } = {}) {
  const source = relative(repoRoot, path);
  const tasks = readFileSync(path, "utf8")
    .split(String.fromCharCode(10))
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

  // Two tasks sharing an id both match the same transcript entry, so one
  // observation is scored twice and reads as full coverage.
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new TypeError(`${source}: task id ${JSON.stringify(task.id)} appears more than once`);
    }
    seen.add(task.id);
  }
  void arms;
  return tasks;
}

const ARM_NAMES_FALLBACK = ["baseline", "agentdesk"];

/**
 * The transcript is external input, so the whole file is validated against
 * the loaded task set before any of it is used. Building the lookup from raw
 * fields first meant an entry naming no arm, or an unknown task, simply never
 * matched and vanished, and a duplicate quietly replaced the first. A dropped
 * entry is indistinguishable from a run that never had one.
 */
export function loadTranscript(path, tasks, { repoRoot = process.cwd(), armNames = ARM_NAMES_FALLBACK } = {}) {
  if (path === undefined) return new Map();
  if (!existsSync(path)) {
    throw new Error(`transcript not found: ${path}`);
  }
  const known = new Set(tasks.map((t) => t.id));
  const source = relative(repoRoot, path);
  const byKey = new Map();

  readFileSync(path, "utf8").split(String.fromCharCode(10)).forEach((rawLine, index) => {
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
      throw new TypeError(`${at} must name an arm, one of ${armNames.join(", ")}`);
    }
    if (!armNames.includes(entry.arm)) {
      throw new TypeError(`${at} names arm ${JSON.stringify(entry.arm)}, not one of ${armNames.join(", ")}`);
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
