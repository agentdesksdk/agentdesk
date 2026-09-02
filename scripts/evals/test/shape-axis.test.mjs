import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARMS, CELLS, probeTask } from "../arms.mjs";
import { buildCatalog } from "../catalog.mjs";
import { loadRecords, loadTasks, loadTranscript } from "../load.mjs";
import { computeMetrics, evidenceCoverage, resultBytes } from "../metrics.mjs";
import { buildReport, renderMarkdown } from "../report.mjs";
import { RECORD_SCHEMA_VERSION, SHAPES, STRUCTURED_FIELDS } from "../schema.mjs";
import { projectResult } from "../shapes.mjs";

/**
 * The second axis. Exposure says what the agent can see before it acts;
 * shape says what it is handed after. `bare` is the terminal result with
 * the situation fields and the evidence stripped to what a plain handler
 * returns, `structured` is what the runtime emits today. Both arms run both
 * shapes, so every metric has four cells and each cell names its shape.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;
const tasks = loadTasks(join(evals, "tasks", "v2.tasks.jsonl"), { repoRoot });
const refund = tasks.find((t) => t.id === "refund-shipping-happy");
const closeAccount = tasks.find((t) => t.id === "close-account");
const readOnly = tasks.find((t) => t.id === "read-invoice");

const STRUCTURED_COMPLETED = {
  status: "COMPLETED",
  result: { order_id: "10428", shipping_refunded: true },
  receipt: {
    entity: "Order #10428",
    changes: [{ field: "shipping_refunded", before: false, after: true }],
    evidence: [{ label: "Shipping line", route: "/orders/10428", reveal: "shipping", source: "authored" }],
  },
  changes: [{ field: "shipping_refunded", before: false, after: true }],
  nowPossible: ["find_order"],
  blockedCapabilities: [],
  evidence: [
    { kind: "receipt", id: "RCPT-1" },
    { kind: "execution", id: "EXEC-1" },
    { kind: "link", label: "Shipping line", route: "/orders/10428", reveal: "shipping", source: "authored" },
  ],
};

function record({ arm = "agentdesk", shape = "structured", taskId = "t", consequential = true, result } = {}) {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION, runId: "p", arm, shape, taskId,
    expectedTools: ["find_capabilities", "refund_shipping"], expectedArguments: {},
    consequential, unsafe: false, terminalTool: "refund_shipping", events: [], notes: [],
    observed: {
      decisionSource: "runtime-probe", selectedTools: null, arguments: null, completed: null,
      approvalRequested: consequential, approvalGranted: consequential, executedWithoutApproval: false,
      dispatched: true, blocked: false, visibleToolCount: 7, schemaBytes: 2557,
      peakVisibleToolCount: 7, peakSchemaBytes: 2557, registeredToolNames: [],
      result,
    },
  };
}

function withJsonl(name, lines, assertion) {
  const path = join(evals, "test", name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    assertion(path);
  } finally {
    rmSync(path, { force: true });
  }
}

test("the canonical cell table is every arm crossed with every shape", () => {
  const keys = Object.keys(CELLS);
  assert.equal(keys.length, Object.keys(ARMS).length * SHAPES.length);
  for (const arm of Object.keys(ARMS)) {
    for (const shape of SHAPES) {
      const cell = CELLS[`${arm}.${shape}`];
      assert.ok(cell, `no cell for ${arm} under ${shape}`);
      assert.equal(cell.arm, arm);
      assert.equal(cell.shape, shape);
      assert.equal(cell.exposure, ARMS[arm].exposure);
      assert.match(cell.label, new RegExp(shape), "the label names the shape so a reader cannot mistake the column");
    }
  }
});

test("the report carries four cells per metric, each naming its arm and its shape", () => {
  const cells = Object.fromEntries(
    Object.values(CELLS).map((cell) => [
      `${cell.arm}.${cell.shape}`,
      {
        ...cell,
        metrics: computeMetrics([
          record({ arm: cell.arm, shape: cell.shape, result: projectResult(cell.shape, STRUCTURED_COMPLETED) }),
        ]),
      },
    ]),
  );
  const report = buildReport({ runId: "p", at: "2026-09-02T00:00:00.000Z", taskSetPath: "t", taskCount: 1, cells });
  assert.equal(Object.keys(report.cells).length, 4);
  const metricNames = new Set(Object.values(report.cells).flatMap((c) => Object.keys(c.metrics)));
  for (const name of metricNames) {
    for (const [key, cell] of Object.entries(report.cells)) {
      assert.ok(cell.metrics[name], `${key} is missing ${name}`);
      assert.ok(SHAPES.includes(cell.shape), `${key} does not name a shape`);
      assert.ok(Object.keys(ARMS).includes(cell.arm), `${key} does not name an arm`);
    }
  }
  const header = renderMarkdown(report).split("\n").find((line) => line.startsWith("| Metric |"));
  assert.ok(header, "the table has a header row");
  assert.equal(header.split("|").length - 3, 4, "one column per cell");
  for (const shape of SHAPES) {
    assert.equal((header.match(new RegExp(shape, "g")) ?? []).length, 2, `${shape} is named on both arms' columns`);
  }
  for (const entry of report.unavailable) {
    assert.ok(SHAPES.includes(entry.shape), "an unavailable entry names the shape it belongs to");
  }
});

test("a bare result keeps only what a plain handler returns", () => {
  assert.deepEqual(projectResult("bare", STRUCTURED_COMPLETED), {
    status: "COMPLETED",
    result: { order_id: "10428", shipping_refunded: true },
  });
  assert.deepEqual(
    projectResult("bare", {
      status: "CAPABILITY_UNAVAILABLE", capability: "delete_all_orders", reasonCode: "DESTRUCTIVE_BULK_ACTION",
      reason: "Bulk deletion is not available from an agent surface.",
      nowPossible: [], blockedCapabilities: ["delete_all_orders"], evidence: [],
    }),
    { status: "CAPABILITY_UNAVAILABLE", reason: "Bulk deletion is not available from an agent surface." },
  );
  assert.deepEqual(
    projectResult("bare", {
      status: "APPROVAL_REQUIRED", approval_id: "ACT-1", summary: "Refund", will_change: [{ field: "x" }],
      nowPossible: [], blockedCapabilities: [], evidence: [{ kind: "approval", id: "ACT-1" }],
    }),
    { status: "APPROVAL_REQUIRED", approval_id: "ACT-1" },
  );
  assert.equal(projectResult("bare", "read_invoice ok"), "read_invoice ok", "a plain text result is already bare");
  assert.deepEqual(projectResult("structured", STRUCTURED_COMPLETED), STRUCTURED_COMPLETED, "structured is what the runtime emitted");
  assert.throws(() => projectResult("terse", STRUCTURED_COMPLETED), /shape/);
});

test("evidence coverage is measured on the structured shape and reports its denominator", () => {
  const withLink = record({ taskId: "a", result: STRUCTURED_COMPLETED });
  const withoutLink = record({
    taskId: "b",
    result: { ...STRUCTURED_COMPLETED, receipt: { ...STRUCTURED_COMPLETED.receipt, evidence: [] } },
  });
  const read = record({
    taskId: "c",
    consequential: false,
    result: { status: "COMPLETED", result: "read_invoice ok", nowPossible: [], blockedCapabilities: [], evidence: [] },
  });
  const metric = evidenceCoverage([withLink, withoutLink, read]);
  assert.equal(metric.provenance, "measured");
  assert.equal(metric.numerator, 1);
  assert.equal(metric.denominator, 2, "only consequential completions are in the denominator");
  assert.equal(metric.value, 0.5);
});

test("evidence coverage on the bare shape is a measured zero, not an unavailable", () => {
  const bare = record({ shape: "bare", result: projectResult("bare", STRUCTURED_COMPLETED) });
  const metric = evidenceCoverage([bare]);
  assert.equal(metric.provenance, "measured");
  assert.equal(metric.value, 0);
  assert.equal(metric.denominator, 1);
});

test("evidence coverage with no consequential completion is unavailable, never zero", () => {
  const read = record({ consequential: false, result: { status: "COMPLETED", result: "ok" } });
  const metric = evidenceCoverage([read]);
  assert.equal(metric.value, null);
  assert.equal(metric.provenance, "unavailable");
});

test("result bytes are the UTF-8 length of what the agent received, so bare costs less than structured", () => {
  const structured = record({ result: STRUCTURED_COMPLETED });
  const bare = record({ shape: "bare", result: projectResult("bare", STRUCTURED_COMPLETED) });
  const s = resultBytes([structured]);
  const b = resultBytes([bare]);
  assert.equal(s.provenance, "measured");
  assert.equal(s.value, new TextEncoder().encode(JSON.stringify(STRUCTURED_COMPLETED)).length);
  assert.ok(b.value < s.value, "stripping the evidence must cost fewer bytes or the axis measures nothing");
  const all = computeMetrics([structured]);
  assert.equal(all.estimatedResultTokens.provenance, "estimated");
  assert.equal(all.estimatedResultTokens.formula, "resultBytes / 4");
  assert.equal(all.estimatedResultTokens.value, Math.round(s.value / 4));
});

test("a bare-shape record whose result still carries a structured field is refused by the loader", () => {
  for (const field of STRUCTURED_FIELDS) {
    const leaked = record({ shape: "bare", result: { status: "COMPLETED", result: {}, [field]: [] } });
    withJsonl(`tmp-bare-${field}.jsonl`, [leaked], (path) =>
      assert.throws(
        () => loadRecords(path, { repoRoot }),
        new RegExp(field),
        `a bare record carrying ${field} must be refused, not scored`,
      ),
    );
  }
});

test("a well-formed bare record and a structured record both load", () => {
  const bare = record({ shape: "bare", result: projectResult("bare", STRUCTURED_COMPLETED) });
  const structured = record({ result: STRUCTURED_COMPLETED });
  withJsonl("tmp-shapes-ok.jsonl", [bare, structured], (path) => {
    const loaded = loadRecords(path, { repoRoot });
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map((r) => r.shape), ["bare", "structured"]);
  });
  withJsonl("tmp-shapes-unknown.jsonl", [record({ shape: "terse", result: {} })], (path) =>
    assert.throws(() => loadRecords(path, { repoRoot }), /shape/),
  );
});

test("a transcript entry names its shape, or is refused", () => {
  const entry = {
    arm: "agentdesk", taskId: refund.id,
    selectedTools: ["find_capabilities", "refund_shipping"], arguments: {}, completed: true,
  };
  withJsonl("tmp-transcript-noshape.jsonl", [entry], (path) =>
    assert.throws(() => loadTranscript(path, tasks, { repoRoot }), /shape/),
  );
  withJsonl("tmp-transcript-badshape.jsonl", [{ ...entry, shape: "terse" }], (path) =>
    assert.throws(() => loadTranscript(path, tasks, { repoRoot }), /terse/),
  );
  withJsonl("tmp-transcript-shaped.jsonl", [{ ...entry, shape: "structured" }], (path) => {
    const loaded = loadTranscript(path, tasks, { repoRoot });
    assert.ok(
      loaded.has(`agentdesk:structured:${refund.id}`),
      "the key carries the shape so a structured transcript cannot score the bare cell",
    );
    assert.equal(loaded.size, 1);
  });
});

test(
  "the probe records the terminal result under its shape, and the catalog authors its evidence",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const probe = async (task, arm, shape) => {
      const { capabilities } = buildCatalog(sdk.defineCapability, sdk.receipt, sdk.unavailable);
      return probeTask({
        createAgentDeskRuntime: sdk.createAgentDeskRuntime, capabilities, task, arm, shape, runId: "shape-axis",
      });
    };
    for (const task of [refund, closeAccount]) {
      const structured = await probe(task, "agentdesk", "structured");
      assert.equal(structured.shape, "structured");
      assert.equal(structured.observed.result.status, "COMPLETED", JSON.stringify(structured.observed.result));
      const links = structured.observed.result.receipt.evidence;
      assert.ok(links.length >= 1, `${task.id} must author at least one evidence link`);
      assert.ok(links.every((l) => l.source === "authored"), "the catalog authors its links; a derived one is only the page");
      assert.equal(evidenceCoverage([structured]).value, 1);

      const bare = await probe(task, "baseline", "bare");
      assert.equal(bare.shape, "bare");
      assert.deepEqual(Object.keys(bare.observed.result).sort(), ["result", "status"]);
      assert.equal(evidenceCoverage([bare]).value, 0);
      assert.equal(bare.observed.approvalRequested, true, "shape changes what the agent is handed, not what the runtime demands");
    }
    const read = await probe(readOnly, "agentdesk", "structured");
    assert.equal(read.observed.result.status, "COMPLETED");
    assert.equal(evidenceCoverage([read]).provenance, "unavailable", "a read is not a consequential completion");
  },
);
