import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTasks, loadTranscript } from "../load.mjs";

/**
 * The "Capturing a transcript" runbook in docs/evaluations.md makes four
 * promises to the human holding the checklist. Each one is checked here, so
 * the runbook cannot drift from what the loader and the task set actually do.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const tasks = loadTasks(join(evals, "tasks", "v2.tasks.jsonl"), { repoRoot });

function withJsonl(path, entries, assertion) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  try {
    assertion(path);
  } finally {
    rmSync(path, { force: true });
  }
}

test("an entry missing a field is refused with the line number and the field name", () => {
  // The runbook tells the human to read the line and the field out of the
  // error and fix that entry. If the loader stopped naming either, the
  // runbook would be describing a message that no longer exists.
  const [first, second] = tasks;
  withJsonl(
    join(evals, "test", "tmp-runbook-missing.jsonl"),
    [
      { arm: "agentdesk", taskId: first.id, selectedTools: ["find_capabilities", first.terminalTool], arguments: {}, completed: true },
      { arm: "agentdesk", taskId: second.id, selectedTools: ["find_capabilities"], arguments: {} },
    ],
    (path) =>
      assert.throws(
        () => loadTranscript(path, tasks, { repoRoot }),
        (err) => {
          assert.match(err.message, /line 2/, "the offending line is named");
          assert.match(err.message, /completed/, "the missing field is named");
          return true;
        },
      ),
  );
});

test("a transcript saved under scripts/evals/transcripts loads by path", () => {
  const dir = join(evals, "transcripts");
  assert.ok(existsSync(dir), "scripts/evals/transcripts is the documented destination and must exist");
  const [task] = tasks;
  withJsonl(
    join(dir, "tmp-runbook-good.jsonl"),
    [{ arm: "baseline", taskId: task.id, selectedTools: [task.terminalTool], arguments: task.expectedArguments, completed: true }],
    (path) => {
      const loaded = loadTranscript(path, tasks, { repoRoot });
      assert.equal(loaded.size, 1);
      assert.ok(loaded.has(`baseline:${task.id}`));
    },
  );
});

test(
  "pnpm eval refuses a malformed transcript before creating a run directory",
  { skip: existsSync(dist) ? false : "dist not built" },
  () => {
    // This is the validation entry point the runbook documents. It has to
    // fail before anything is written, or a bad transcript would leave a
    // half-run behind that looks like a result.
    const out = join(evals, "test", "tmp-runbook-cli-out");
    withJsonl(
      join(evals, "test", "tmp-runbook-cli.jsonl"),
      [{ arm: "baseline", taskId: tasks[0].id, selectedTools: [], arguments: {} }],
      (path) => {
        const result = spawnSync(process.execPath, [join(evals, "run.mjs"), "--transcript", path, "--out", out], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
        assert.match(result.stderr, /completed/, "the missing field is named on stderr");
        assert.match(result.stderr, /line 1/, "the offending line is named on stderr");
        assert.equal(existsSync(out), false, "a refused transcript must not leave a run directory behind");
      },
    );
  },
);

test("the runbook quotes every task prompt verbatim, in task-set order", () => {
  const doc = readFileSync(join(repoRoot, "docs", "evaluations.md"), "utf8");
  assert.match(doc, /## Capturing a transcript/, "docs/evaluations.md has no runbook section");
  let cursor = 0;
  for (const task of tasks) {
    const at = doc.indexOf(task.prompt, cursor);
    assert.notEqual(
      at,
      -1,
      `docs/evaluations.md does not quote task ${task.id} after the task before it: ${JSON.stringify(task.prompt)}`,
    );
    cursor = at + task.prompt.length;
  }
});
