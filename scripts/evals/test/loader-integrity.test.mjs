import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTasks, loadTranscript } from "../load.mjs";

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

test("importing the loaders runs no evaluation and writes nothing", () => {
  assert.equal(typeof loadTasks, "function");
  assert.equal(typeof loadTranscript, "function");
  const runs = readdirSync(join(evals, "runs"));
  assert.deepEqual(
    runs.filter((entry) => entry.startsWith("eval-")),
    [],
    "a test run wrote an evaluation directory, which means importing a helper executed the CLI",
  );
});

test("every record in a run agrees on one run id", () => {
  const jsonl = (p) =>
    readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  const ids = new Set();
  for (const arm of ["baseline", "agentdesk"]) {
    for (const record of jsonl(join(evals, "runs", "reference", `records.${arm}.jsonl`))) {
      ids.add(record.runId);
    }
  }
  assert.equal(ids.size, 1, `records disagree on their run id: ${[...ids].join(", ")}`);
  assert.ok([...ids][0].length > 0, "run id must not be empty");
});
