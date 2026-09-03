import { useState } from "react";
import { createAgentDeskRuntime } from "@agentdesksdk/webmcp";
import { capabilities } from "../capabilities/index.ts";
import { stagingAdapter } from "../capabilities/staged.ts";
import { StatCard } from "../components/bits.tsx";
import { useBenchmark, useRuntime } from "../components/hooks.ts";
import { getCommittedState, land, resetStore } from "../data/store.ts";
import {
  benchmark,
  estimateTokens,
  isComparableComparison,
  isComparableRun,
} from "../instrumentation/benchmark.ts";
import {
  BOOTSTRAP,
  REFUND_SHIPPING_HAPPY,
  runSideBySide,
} from "../instrumentation/sideBySide.ts";
import { agentdesk, OPERATOR } from "../runtime/agentdesk.ts";

type SideBySide =
  | { status: "idle" }
  | { status: "running" }
  | { status: "failed"; message: string };

export function Benchmark() {
  const snapshot = useRuntime();
  const bench = useBenchmark();
  const [sideBySide, setSideBySide] = useState<SideBySide>({ status: "idle" });

  async function runBothModes() {
    const openPlan = snapshot.plans.find((plan) =>
      plan.status === "DRAFT" ||
      plan.status === "APPROVED" ||
      plan.status === "COMMITTING"
    );
    if (
      snapshot.pending.length > 0 ||
      openPlan !== undefined ||
      agentdesk.listUnreconciled().length > 0
    ) {
      setSideBySide({
        status: "failed",
        message:
          "Finish or reject the open approval or plan before benchmarking; the comparison will not invalidate a reviewed proposal.",
      });
      return;
    }
    setSideBySide({ status: "running" });
    const documentBefore = structuredClone(getCommittedState());
    // A probe runtime over the page's own catalog and staging adapter, built
    // the way `pnpm eval` builds one. The page's runtime is left alone: its
    // guided presence navigates on every invoke, which would unmount this
    // page mid-run, and the shell re-asserts the route's exposure on each
    // navigation, which would flip an arm halfway through its measurement.
    const probe = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      staging: stagingAdapter,
      actor: { id: "agent", name: "Agent", kind: "agent" },
      exposure: snapshot.exposure,
    });
    try {
      await probe.start();
      const rows = await runSideBySide({
        runtime: probe,
        task: REFUND_SHIPPING_HAPPY,
        approver: OPERATOR,
        // The same seed for both arms, the way each eval arm gets a fresh
        // catalog: the store back to its seed and the probe's own
        // bookkeeping cleared.
        reset: async () => {
          resetStore();
          await probe.reset();
        },
        restore: async () => {
          land(documentBefore);
          await probe.reset();
        },
      });
      benchmark.saveComparison(rows);
      setSideBySide({ status: "idle" });
    } catch (err) {
      setSideBySide({
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await probe.stop();
    }
  }
  const comparison = bench.comparison;
  const comparisonRows = comparison?.rows;
  const modeLabel = snapshot.exposure === "flat" ? "Baseline (flat)" : "AgentDesk (routed)";
  const runtimeTools = snapshot.nativeTools.filter((name) => BOOTSTRAP.has(name)).length;
  const appTools = snapshot.nativeTools.length - runtimeTools;

  return (
    <>
      <h1>Benchmark</h1>
      <p className="page-sub">
        Everything below is measured from the live runtime: real registered
        tool definitions, real invocation counts. Token figures are estimates
        (bytes ÷ 4, same estimator for both modes). Nothing is hardcoded.
        Fair comparison point: measure both modes at task time (peak), not
        AgentDesk&apos;s idle surface.
      </p>
      <div className="cards">
        <StatCard label="Mode" value={modeLabel} />
        <StatCard label="Application capabilities" value={snapshot.catalogSize} />
        <StatCard
          label="Active WebMCP tools"
          value={snapshot.nativeTools.length}
          hint={`${appTools} application + ${runtimeTools} runtime`}
        />
        <StatCard
          label="Schema bytes now"
          value={snapshot.schemaBytes.toLocaleString()}
          hint={`≈ ${estimateTokens(snapshot.schemaBytes).toLocaleString()} tokens (estimated)`}
        />
      </div>
      <div className="panel">
        <h2>Same task, both modes</h2>
        <p className="page-sub" style={{ marginBottom: 12 }}>
          Runs the eval task <code>{REFUND_SHIPPING_HAPPY.id}</code> (&ldquo;
          {REFUND_SHIPPING_HAPPY.prompt}&rdquo;) under flat exposure, then
          routed, on a runtime built from this page&apos;s catalog the way{" "}
          <code>pnpm eval</code> builds one. Each arm starts from the demo
          seed; the harness approves the refund as a person would, so both
          arms complete without a click. The document the operator had before
          the probe is restored when the run ends. Both columns are the task-time peak:
          sampled after routing and after execution, the larger reported.
        </p>
        <div className="bench-controls">
          <button
            className="primary"
            disabled={sideBySide.status === "running" || bench.activeRun !== null}
            onClick={() => void runBothModes()}
          >
            {sideBySide.status === "running"
              ? "Running both modes…"
              : "Run in both modes"}
          </button>
          {bench.activeRun ? (
            <span className="est">Stop or discard the timed run first.</span>
          ) : null}
          {sideBySide.status === "failed" ? (
            <span className="est">Run failed: {sideBySide.message}</span>
          ) : null}
        </div>
        <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Visible application tools (peak)</th>
              <th>Schema bytes (peak)</th>
              <th>Approval requested</th>
              <th>Blocked</th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows === undefined ? (
              <tr>
                <td colSpan={5} className="empty">
                  Not run yet.
                </td>
              </tr>
            ) : (
              comparisonRows.map((row) => (
                <tr key={row.exposure}>
                  <td>
                    {row.exposure === "flat" ? "baseline" : "agentdesk"}
                    {comparison !== null && !isComparableComparison(comparison)
                      ? " (stale)"
                      : ""}
                  </td>
                  <td>{row.peakApplicationTools}</td>
                  <td>{row.peakSchemaBytes.toLocaleString()}</td>
                  <td>{row.approvalRequested ? "yes" : "no"}</td>
                  <td>{row.blocked ? "yes" : "no"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
        {comparisonRows !== undefined ? (
          <button onClick={() => benchmark.clearComparison()}>
            Clear comparison
          </button>
        ) : null}
      </div>
      <div className="panel">
        <h2>Timed task run</h2>
        <p className="page-sub" style={{ marginBottom: 12 }}>
          Start a run, complete the hero task with your agent (find Alice
          Johnson&apos;s unshipped order and refund shipping with approval),
          then stop. The run auto-marks completion when refund_shipping
          executes. Run it once per mode for a fair side-by-side.
        </p>
        <div className="bench-controls">
          {bench.activeRun ? (
            <>
              <button className="primary" onClick={() => benchmark.stopRun()}>
                Stop &amp; save run
              </button>
              <button onClick={() => benchmark.discardActive()}>Discard</button>
              <span className="est">
                Recording in {bench.activeRun.mode === "flat" ? "baseline" : "agentdesk"}{" "}
                mode · {bench.activeRun.invocations} invocations
                {bench.activeRun.heroCompleted ? " · hero task complete" : ""}
              </span>
            </>
          ) : (
            <button
              className="primary"
              disabled={bench.starting}
              onClick={() => void benchmark.startRun()}
            >
              {bench.starting ? "Resetting to benchmark seed…" : "Start fresh run in current mode"}
            </button>
          )}
          <button onClick={() => benchmark.clearRuns()}>Clear saved runs</button>
        </div>
        <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Comparable</th>
              <th>Peak tools</th>
              <th>Bytes before routing</th>
              <th>Bytes peak (task)</th>
              <th>Est. tokens (peak)</th>
              <th>Invocations</th>
              <th>Stale calls</th>
              <th>Approvals</th>
              <th>Hero done</th>
              <th>Elapsed</th>
            </tr>
          </thead>
          <tbody>
            {bench.runs.length === 0 ? (
              <tr>
                <td colSpan={11} className="empty">
                  No saved runs yet.
                </td>
              </tr>
            ) : (
              bench.runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.mode === "flat" ? "baseline" : "agentdesk"}</td>
                  <td>{isComparableRun(run) ? "current" : "stale"}</td>
                  <td>{run.activeTools}</td>
                  <td>{run.schemaBytesStart.toLocaleString()}</td>
                  <td>{run.schemaBytesPeak.toLocaleString()}</td>
                  <td>
                    {estimateTokens(run.schemaBytesPeak).toLocaleString()}
                    <span className="est"> est.</span>
                  </td>
                  <td>{run.invocations}</td>
                  <td>{run.staleCalls}</td>
                  <td>{run.approvals}</td>
                  <td>{run.heroCompleted ? "yes" : "no"}</td>
                  <td>
                    {run.elapsedMs !== null
                      ? `${(run.elapsedMs / 1000).toFixed(1)}s`
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>
      <div className="panel">
        <h2>What is and is not measured</h2>
        <ul className="note-list">
          <li>
            Starting a timed run resets Meridian Ops to the canonical seed.
            Only rows from this benchmark revision, scenario, and catalog are
            marked comparable; older saved rows stay visible as stale.
          </li>
          <li>
            Schema bytes are the UTF-8 length of the serialized tool
            definitions actually registered with WebMCP right now.
          </li>
          <li>
            A run records bytes before routing, the peak during the task, and
            the value at stop. Compare modes at peak; AgentDesk&apos;s idle
            4-tool surface is not the comparison figure.
          </li>
          <li>
            Estimated tokens use the same bytes÷4 heuristic for both modes and
            are labelled as estimates.
          </li>
          <li>
            Model token consumption is not measured and never claimed; it
            depends on the client.
          </li>
          <li>
            Stale calls count invocations of retired (tombstoned) tools.
          </li>
        </ul>
      </div>
    </>
  );
}
