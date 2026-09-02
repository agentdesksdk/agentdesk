import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARMS } from "../arms.mjs";
import { buildCatalog } from "../catalog.mjs";
import { loadTasks } from "../load.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;

const HUMAN = Object.freeze({ id: "evaluator", name: "Evaluator", kind: "human" });
const task = loadTasks(join(evals, "tasks", "v2.tasks.jsonl"), { repoRoot }).find(
  (t) => t.id === "refund-shipping-happy",
);

/**
 * The catalog says refunding an already-refunded order is refused with
 * ALREADY_REFUNDED. Issue #28: that guard was declared on `availability`,
 * which receives the application context rather than the input, so it could
 * never fire. This drives the same order twice through a runtime built the
 * way `probeTask` builds one and asks the runtime, not the store.
 */
test(
  "refunding the same order twice is refused as ALREADY_REFUNDED and writes nothing",
  { skip: sdk ? false : "dist not built" },
  async () => {
    const { capabilities, store } = buildCatalog(sdk.defineCapability, sdk.receipt, sdk.unavailable);
    const runtime = sdk.createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      exposure: ARMS.agentdesk.exposure,
      actor: { id: "eval-agent", name: "Eval Agent", kind: "agent" },
    });
    await runtime.start();
    await runtime.routeTask(task.prompt);

    const first = await runtime.invoke(task.terminalTool, { ...task.terminalInput });
    assert.equal(first.data?.status, "APPROVAL_REQUIRED", JSON.stringify(first.data));
    const pending = runtime.getSnapshot().pending;
    assert.equal(pending.length, 1);
    const granted = await runtime.approve(pending[0].id, HUMAN);
    assert.notEqual(granted.isError, true, JSON.stringify(granted.data));
    assert.ok(store.refunded.has("10428"), "the first refund must actually land for the second to mean anything");
    const writesAfterFirst = store.log.filter((name) => name === "refund_shipping").length;
    const receiptsAfterFirst = runtime.queryReceipts().length;
    assert.equal(writesAfterFirst, 1);

    const second = await runtime.invoke(task.terminalTool, { ...task.terminalInput });
    assert.equal(second.isError, true, `second attempt was not refused: ${JSON.stringify(second.data)}`);
    assert.equal(second.data?.status, "CAPABILITY_UNAVAILABLE", JSON.stringify(second.data));
    assert.equal(second.data?.reasonCode, "ALREADY_REFUNDED", JSON.stringify(second.data));

    const after = runtime.getSnapshot();
    assert.equal(after.pending.length, 0, "a refused refund must not open a second approval");
    assert.equal(store.log.filter((name) => name === "refund_shipping").length, writesAfterFirst, "the refused attempt wrote");
    assert.equal(runtime.queryReceipts().length, receiptsAfterFirst, "the refused attempt produced a receipt");
    assert.equal(
      after.audit.filter((e) => e.kind === "approval_requested").length,
      1,
      "the refused attempt requested approval",
    );
    await runtime.stop();
  },
);
