import { StatCard } from "../components/bits.tsx";
import { useBenchmark, useRuntime } from "../components/hooks.ts";
import { benchmark, estimateTokens } from "../instrumentation/benchmark.ts";

export function Benchmark() {
  const snapshot = useRuntime();
  const bench = useBenchmark();
  const modeLabel = snapshot.exposure === "flat" ? "Baseline (flat)" : "AgentDesk (routed)";

  return (
    <>
      <h1>Benchmark</h1>
      <p className="page-sub">
        Everything below is measured from the live runtime: real registered
        tool definitions, real invocation counts. Token figures are estimates
        (bytes ÷ 4, same estimator for both modes). Nothing is hardcoded.
      </p>
      <div className="cards">
        <StatCard label="Mode" value={modeLabel} />
        <StatCard label="Catalog capabilities" value={snapshot.catalogSize} />
        <StatCard label="Active WebMCP tools" value={snapshot.nativeTools.length} />
        <StatCard
          label="Schema bytes"
          value={snapshot.schemaBytes.toLocaleString()}
          hint={`≈ ${estimateTokens(snapshot.schemaBytes).toLocaleString()} tokens (estimated)`}
        />
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
            <button className="primary" onClick={() => benchmark.startRun()}>
              Start run in current mode
            </button>
          )}
          <button onClick={() => benchmark.clearRuns()}>Clear saved runs</button>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Active tools</th>
              <th>Schema bytes</th>
              <th>Est. tokens</th>
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
                <td colSpan={9} className="empty">
                  No saved runs yet.
                </td>
              </tr>
            ) : (
              bench.runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.mode === "flat" ? "baseline" : "agentdesk"}</td>
                  <td>{run.activeTools}</td>
                  <td>{run.schemaBytes.toLocaleString()}</td>
                  <td>
                    {estimateTokens(run.schemaBytes).toLocaleString()}
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
      <div className="panel">
        <h2>What is and is not measured</h2>
        <ul className="note-list">
          <li>
            Schema bytes are the UTF-8 length of the serialized tool
            definitions actually registered with WebMCP right now.
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
