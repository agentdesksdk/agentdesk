import { useEffect, useRef, useState } from "react";
import { agentdesk, webmcpNative } from "../runtime/agentdesk.ts";
import { useRuntime } from "./hooks.ts";

const BOOTSTRAP = new Set([
  "find_capabilities",
  "invoke_capability",
  "get_context",
  "get_action_status",
]);

export function Inspector() {
  const snapshot = useRuntime();
  const [query, setQuery] = useState("");
  const routedCount =
    snapshot.exposure === "flat"
      ? snapshot.nativeTools.filter((name) => !BOOTSTRAP.has(name)).length
      : snapshot.routedTools.length;

  const previous = useRef(routedCount);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (previous.current !== routedCount) {
      previous.current = routedCount;
      setBump(true);
      const timer = setTimeout(() => setBump(false), 550);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [routedCount]);

  const appTools = snapshot.nativeTools.filter((name) => !BOOTSTRAP.has(name));
  const bootstrapTools = snapshot.nativeTools.filter((name) =>
    BOOTSTRAP.has(name),
  );
  const unavailableMatches =
    snapshot.lastRouting?.matches.filter((match) => !match.available) ?? [];

  return (
    <>
      <div className="rail-section">
        <h3>Capability virtualization</h3>
        <div className="reduction" title="internal capabilities → routed application tools">
          <span className="from">{snapshot.catalogSize}</span>
          <span className="arrow">→</span>
          <span className={`to${bump ? " bump" : ""}`}>{routedCount}</span>
        </div>
        <div className="stat-row">
          <span>Internal capabilities</span>
          <span className="num">{snapshot.catalogSize}</span>
        </div>
        <div className="stat-row">
          <span>Active WebMCP tools</span>
          <span className="num">{snapshot.nativeTools.length}</span>
        </div>
        <div className="stat-row">
          <span>Routed application tools</span>
          <span className="num">{routedCount}</span>
        </div>
        <div className="stat-row">
          <span>Schema bytes on the wire</span>
          <span className="num">{snapshot.schemaBytes.toLocaleString()}</span>
        </div>
        <div className="stat-row">
          <span>WebMCP support</span>
          <span className="num">
            {webmcpNative
              ? "native"
              : snapshot.supported
                ? "simulated in-page"
                : "not detected"}
          </span>
        </div>
      </div>

      <div className="rail-section">
        <h3>Route a task</h3>
        <form
          className="route-task"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim() !== "") {
              void agentdesk.routeTask(query.trim());
            }
          }}
        >
          <input
            type="text"
            name="task-query"
            aria-label="Task to route"
            value={query}
            placeholder="e.g. refund shipping for Alice"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" className="primary">
            Route
          </button>
        </form>
      </div>

      <div className="rail-section">
        <h3>Active tools</h3>
        <div className="chips">
          {bootstrapTools.map((name) => (
            <span key={name} className="chip bootstrap">
              {name}
            </span>
          ))}
          {appTools.map((name) => (
            <span key={name} className="chip">
              {name}
            </span>
          ))}
        </div>
        {snapshot.tombstones.length > 0 ? (
          <>
            <h3 style={{ marginTop: 12 }}>Retired (tombstoned)</h3>
            <div className="chips">
              {snapshot.tombstones.map((name) => (
                <span key={name} className="chip tombstone">
                  {name}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {unavailableMatches.length > 0 ? (
        <div className="rail-section">
          <h3>Relevant but unavailable</h3>
          {unavailableMatches.map((match) => (
            <div key={match.name} className="match">
              <span className="name">{match.name}</span>{" "}
              <span className={`risk ${match.risk}`}>{match.risk}</span>
              <div className="why">
                {match.reasonCode}: {match.reason}
              </div>
              {match.suggestedCapability ? (
                <div className="suggest">
                  Try {match.suggestedCapability} instead.
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
