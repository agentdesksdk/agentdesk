import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRecords, loadTasks, loadTranscript } from "../load.mjs";
import { CELLS } from "../arms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");

function withFile(name, lines, assertion) {
  const path = join(evals, "test", name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    assertion(path);
  } finally {
    rmSync(path, { force: true });
  }
}

const task = (id, prompt) => ({
  schemaVersion: 2,
  id,
  prompt,
  expectedTools: { baseline: ["read_invoice"], agentdesk: ["find_capabilities", "read_invoice"] },
  expectedArguments: {},
  consequential: false,
  unsafe: false,
  terminalTool: "read_invoice",
  terminalInput: {},
});

test("a task set with a duplicate id is refused", () => {
  // Two tasks sharing an id both match the same transcript entry, so one
  // observation is counted twice and reads as full coverage.
  withFile("tmp-dupe-tasks.jsonl", [task("twin", "first"), task("twin", "second")], (path) =>
    assert.throws(() => loadTasks(path), /duplicate|twin/i),
  );
});

test("a task set with unique ids loads", () => {
  withFile("tmp-ok-tasks.jsonl", [task("a", "first"), task("b", "second")], (path) =>
    assert.equal(loadTasks(path).length, 2),
  );
});

test("importing the loaders creates nothing and prints nothing", () => {
  // A snapshot around a fresh process, not an assertion that the directory is
  // empty. Requiring emptiness punished a legitimate earlier `pnpm eval`, and
  // it never showed that this import was the thing that wrote anything: it
  // only showed what happened to be on disk.
  const runs = join(evals, "runs");
  const before = new Set(readdirSync(runs));

  const loader = pathToFileURL(join(evals, "load.mjs")).href;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(loader)});`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const after = new Set(readdirSync(runs));
  const created = [...after].filter((entry) => !before.has(entry));
  assert.deepEqual(created, [], "importing a loader wrote into the run directory, so it executed the CLI");
  assert.equal(output, "", "importing a loader printed to stdout, so it executed the CLI");
});

test("every record in a run agrees on one run id", () => {
  const repoRoot = resolve(evals, "..", "..");
  const ids = new Set();
  for (const key of Object.keys(CELLS)) {
    for (const record of loadRecords(join(evals, "runs", "reference", `records.${key}.jsonl`), { repoRoot })) {
      ids.add(record.runId);
    }
  }
  assert.equal(ids.size, 1, `records disagree on their run id: ${[...ids].join(", ")}`);
  assert.ok([...ids][0].length > 0, "run id must not be empty");
});
