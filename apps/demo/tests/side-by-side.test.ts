import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  unavailable,
  type Actor,
  type Capability,
  type Exposure,
} from "@agentdesksdk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { stagingAdapter } from "../src/capabilities/staged.ts";
import { getCommittedState, getState, land, mutate, resetStore } from "../src/data/store.ts";
import {
  BOOTSTRAP_TOOLS,
  measureArm,
  REFUND_SHIPPING_HAPPY,
  runSideBySide,
  type ArmMeasurement,
  type SideBySideTask,
} from "../src/instrumentation/sideBySide.ts";

/**
 * The eval harness is plain ESM outside this package, imported by file URL
 * the way `scripts/evals/run.mjs` imports the SDK dist. The shapes below are
 * the subset this test reads; anything else the harness returns is ignored.
 */
type EvalArm = "baseline" | "agentdesk";
type ProbeObserved = {
  approvalRequested: boolean;
  blocked: boolean;
  peakVisibleToolCount: number;
  peakSchemaBytes: number;
};
type ProbeRecord = { taskId: string; observed: ProbeObserved };
type ArmsModule = {
  ARMS: Record<EvalArm, { arm: EvalArm; exposure: Exposure }>;
  probeTask: (args: {
    createAgentDeskRuntime: typeof createAgentDeskRuntime;
    capabilities: Capability[];
    task: SideBySideTask;
    arm: EvalArm;
    shape: "bare" | "structured";
    runId: string;
  }) => Promise<ProbeRecord>;
};
type CatalogModule = {
  buildCatalog: (
    define: typeof defineCapability,
    makeReceipt: typeof receipt,
    makeUnavailable: typeof unavailable,
  ) => { capabilities: Capability[] };
};
type SurfaceMetric = { max: number; min: number };
type Report = {
  cells: Record<
    string,
    { metrics: { visibleToolCount: SurfaceMetric; registeredSchemaBytes: SurfaceMetric } }
  >;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const evalsDir = join(repoRoot, "scripts", "evals");
const referenceDir = join(evalsDir, "runs", "reference");
const evalModule = <T>(name: string): Promise<T> =>
  import(pathToFileURL(join(evalsDir, name)).href) as Promise<T>;

const TASK_ID = "refund-shipping-happy";
const HUMAN: Actor = { id: "evaluator", name: "Evaluator", kind: "human" };
const ARM_OF: Record<Exposure, EvalArm> = { flat: "baseline", routed: "agentdesk" };

function jsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

function fixtureTask(): SideBySideTask {
  const task = jsonl<SideBySideTask>(join(evalsDir, "tasks", "v2.tasks.jsonl")).find(
    (t) => t.id === TASK_ID,
  );
  if (!task) {
    throw new Error(`${TASK_ID} is not in the v2 task set`);
  }
  return task;
}

function referenceRecord(arm: EvalArm): ProbeObserved {
  const record = jsonl<ProbeRecord>(join(referenceDir, `records.${arm}.structured.jsonl`)).find(
    (r) => r.taskId === TASK_ID,
  );
  if (!record) {
    throw new Error(`${TASK_ID} has no reference record for ${arm}`);
  }
  return record.observed;
}

/** The four fields a judge compares, whichever side produced them. */
const peakOf = (row: ProbeObserved): ProbeObserved => ({
  approvalRequested: row.approvalRequested,
  blocked: row.blocked,
  peakVisibleToolCount: row.peakVisibleToolCount,
  peakSchemaBytes: row.peakSchemaBytes,
});

/** Builds the runtime exactly as `probeTask` in `scripts/evals/arms.mjs` does. */
async function evalRuntime(exposure: Exposure) {
  const { buildCatalog } = await evalModule<CatalogModule>("catalog.mjs");
  const { capabilities: catalog } = buildCatalog(defineCapability, receipt, unavailable);
  const runtime = createAgentDeskRuntime({
    capabilities: catalog,
    registerTool: async () => {},
    exposure,
    actor: { id: "eval-agent", name: "Eval Agent", kind: "agent" },
  });
  await runtime.start();
  return runtime;
}

describe("side-by-side benchmark: the eval harness's numbers", () => {
  it("ships the fixture the demo control runs, verbatim from the task set", () => {
    expect(fixtureTask()).toMatchObject(REFUND_SHIPPING_HAPPY);
  });

  it.each<Exposure>(["flat", "routed"])(
    "%s arm reproduces the reference record and the live probe for refund-shipping-happy",
    async (exposure) => {
      const arm = ARM_OF[exposure];
      const task = fixtureTask();

      const runtime = await evalRuntime(exposure);
      const row = await measureArm(runtime, task, { approver: HUMAN });
      await runtime.stop();
      expect(row.exposure).toBe(exposure);

      // The same numbers `pnpm eval` wrote for this task. The report only
      // carries aggregates, so the per-task record is the figure compared
      // and the report's range must contain it.
      expect(peakOf(row)).toEqual(peakOf(referenceRecord(arm)));
      const report = JSON.parse(readFileSync(join(referenceDir, "report.json"), "utf8")) as Report;
      const cell = report.cells[`${arm}.structured`];
      if (!cell) {
        throw new Error(`${arm}.structured has no cell in the reference report`);
      }
      const { visibleToolCount, registeredSchemaBytes } = cell.metrics;
      expect(row.peakVisibleToolCount).toBeGreaterThanOrEqual(visibleToolCount.min);
      expect(row.peakVisibleToolCount).toBeLessThanOrEqual(visibleToolCount.max);
      expect(row.peakSchemaBytes).toBeGreaterThanOrEqual(registeredSchemaBytes.min);
      expect(row.peakSchemaBytes).toBeLessThanOrEqual(registeredSchemaBytes.max);

      // And the harness itself, driven live against the SDK in this tree.
      const { probeTask } = await evalModule<ArmsModule>("arms.mjs");
      const { buildCatalog } = await evalModule<CatalogModule>("catalog.mjs");
      const probed = await probeTask({
        createAgentDeskRuntime,
        capabilities: buildCatalog(defineCapability, receipt, unavailable).capabilities,
        task,
        arm,
        shape: "structured",
        runId: "side-by-side-test",
      });
      expect(peakOf(row)).toEqual(peakOf(probed.observed));
    },
  );

  it("counts application tools as native tools minus the bootstrap set", async () => {
    const runtime = await evalRuntime("flat");
    const row = await measureArm(runtime, fixtureTask(), { approver: HUMAN });
    await runtime.stop();
    expect(BOOTSTRAP_TOOLS).toEqual([
      "find_capabilities",
      "invoke_capability",
      "get_context",
      "get_action_status",
    ]);
    expect(row.peakApplicationTools).toBe(row.peakVisibleToolCount - BOOTSTRAP_TOOLS.length);
  });
});

describe("side-by-side benchmark: the demo runtime", () => {
  const OPERATOR: Actor = { id: "operator", name: "Operator", kind: "human" };

  beforeEach(() => {
    resetStore();
  });

  it("runs both arms from the seed, then restores the document it found", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      exposure: "routed",
    });
    await runtime.start();
    mutate((draft) => {
      draft.orders.find((order) => order.id === "10428")!.notes.push(
        "Keep this operator note.",
      );
    });
    const before = structuredClone(getCommittedState());
    const resets: number[] = [];
    const rows = await runSideBySide({
      runtime,
      task: REFUND_SHIPPING_HAPPY,
      approver: OPERATOR,
      reset: async () => {
        resets.push(getState().credits.length);
        resetStore();
        await runtime.reset();
      },
      restore: async () => {
        land(before);
        await runtime.reset();
      },
    });

    expect(rows.map((r) => r.exposure)).toEqual(["flat", "routed"]);
    const [flat, routed] = rows as [ArmMeasurement, ArmMeasurement];

    // Every arm starts from the seed: the reset before the routed arm saw the
    // credit the flat arm's refund issued, and cleared it.
    expect(resets).toEqual([0, 1]);

    expect(flat.peakVisibleToolCount).toBe(capabilities.length + BOOTSTRAP_TOOLS.length);
    expect(flat.peakApplicationTools).toBe(capabilities.length);
    expect(routed.peakApplicationTools).toBeLessThan(flat.peakApplicationTools);
    expect(routed.peakSchemaBytes).toBeLessThan(flat.peakSchemaBytes);
    for (const row of rows) {
      expect(row.approvalRequested).toBe(true);
      expect(row.blocked).toBe(false);
      expect(row.peakSchemaBytes).toBeGreaterThan(0);
    }

    // The page is handed back the way the run found it.
    expect(runtime.getSnapshot().exposure).toBe("routed");
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(getCommittedState()).toEqual(before);
    await runtime.stop();
  });

  it("records a receipt for every mutation in a five-operation plan", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      exposure: "routed",
    });
    await runtime.start();
    const plan = await runtime.prepare({
      summary: "Five governed updates",
      operations: [
        { capability: "add_order_note", input: { order_id: "10428", note: "Extra foam" } },
        { capability: "mark_order_shipped", input: { order_id: "10408" } },
        { capability: "adjust_stock", input: { sku: "MER-DSK-01", delta: 1 } },
        { capability: "apply_discount", input: { invoice_id: "INV-3021", percent: 5 } },
        {
          capability: "issue_credit",
          input: { customer_id: "C-1001", amount: 10, reason: "Service recovery" },
        },
      ],
    });
    expect(runtime.approvePlan(plan.id, OPERATOR).ok).toBe(true);
    expect((await runtime.commitPlan(plan.id)).ok).toBe(true);

    expect(runtime.queryReceipts({ planId: plan.id }).map((entry) => entry.capability)).toEqual(
      expect.arrayContaining([
        "add_order_note",
        "mark_order_shipped",
        "adjust_stock",
        "apply_discount",
        "issue_credit",
      ]),
    );
    expect(runtime.queryReceipts({ planId: plan.id })).toHaveLength(5);
    await runtime.stop();
  });

  it("keeps an existing receipt consistent with its restored document", async () => {
    const live = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      exposure: "routed",
    });
    const probe = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      exposure: "routed",
    });
    await live.start();
    await probe.start();
    await live.invoke("adjust_stock", { sku: "MER-DSK-01", delta: 2 });
    const receiptBefore = live.queryReceipts()[0]!;
    const documentBefore = structuredClone(getCommittedState());

    await runSideBySide({
      runtime: probe,
      task: REFUND_SHIPPING_HAPPY,
      approver: OPERATOR,
      reset: async () => {
        resetStore();
        await probe.reset();
      },
      restore: async () => {
        land(documentBefore);
        await probe.reset();
      },
    });

    expect(live.queryReceipts()).toEqual([receiptBefore]);
    const stockChange = receiptBefore.receipt.changes.find((change) =>
      change.field.endsWith("stock"),
    );
    expect(
      getCommittedState().products.find((product) => product.sku === "MER-DSK-01")
        ?.stock,
    ).toBe(stockChange?.after);
    await probe.stop();
    await live.stop();
  });

  it("restores the original exposure even when document restoration fails", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      exposure: "routed",
    });
    await runtime.start();

    await expect(
      runSideBySide({
        runtime,
        task: REFUND_SHIPPING_HAPPY,
        approver: OPERATOR,
        exposures: ["flat"],
        reset: async () => {
          resetStore();
          await runtime.reset();
        },
        restore: async () => {
          throw new Error("document restore failed");
        },
      }),
    ).rejects.toThrow("document restore failed");
    expect(runtime.getSnapshot().exposure).toBe("routed");
    await runtime.stop();
  });
});
