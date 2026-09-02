import { Fragment, useEffect, useRef, useState } from "react";
import { ROUTING_WEIGHTS, type RuntimeSnapshot } from "@agentdesk/webmcp";
import { BOOTSTRAP } from "../instrumentation/sideBySide.ts";
import { agentdesk, webmcpNative } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { authorityClauses } from "./grant-text.ts";
import { useRuntime } from "./hooks.ts";

/**
 * How many application tools the agent can call right now, bootstrap aside.
 * Under "routed" exposure that is the working set; under "flat" it is every
 * registered application tool. Exposure is one of those two strings.
 */
export function agentVisibleTools(snapshot: RuntimeSnapshot): number {
  return snapshot.exposure === "flat"
    ? snapshot.nativeTools.filter((name) => !BOOTSTRAP.has(name)).length
    : snapshot.routedTools.length;
}

type RoutingReport = NonNullable<RuntimeSnapshot["lastRouting"]>;
type RoutedMatch = RoutingReport["matches"][number];

function availabilityText(match: RoutedMatch, report: RoutingReport): string {
  if (!match.available) {
    return "unavailable";
  }
  return report.activated.includes(match.name)
    ? "available, active as a native tool"
    : "available";
}

export function Inspector() {
  const snapshot = useRuntime();
  const [query, setQuery] = useState("");
  const routedCount = agentVisibleTools(snapshot);

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

  // A routing decision is announced once, when it is made. The report on
  // mount is history, not news, so it seeds the ref instead of being spoken.
  const { announcement, announce } = useAnnouncer(4000);
  const announced = useRef(snapshot.lastRouting);
  useEffect(() => {
    const report = snapshot.lastRouting;
    if (report === null || report === announced.current) {
      return;
    }
    announced.current = report;
    announce(
      `Routed ${snapshot.catalogSize} candidates to ${report.activated.length} active tool${
        report.activated.length === 1 ? "" : "s"
      }.`,
    );
  }, [snapshot.lastRouting, snapshot.catalogSize, announce]);

  const appTools = snapshot.nativeTools.filter((name) => !BOOTSTRAP.has(name));
  const bootstrapTools = snapshot.nativeTools.filter((name) =>
    BOOTSTRAP.has(name),
  );
  const report = snapshot.lastRouting;

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="rail-section">
        <h3>Capability virtualization</h3>
        <div className="reduction" title="internal capabilities → routed application tools">
          <span className="from">{snapshot.catalogSize}</span>
          <span className="arrow">→</span>
          <span className={`to${bump ? " bump" : ""}`}>{routedCount}</span>
        </div>
        <div className="stat-row">
          <span>Application capabilities</span>
          <span className="num">{snapshot.catalogSize}</span>
        </div>
        <div className="stat-row">
          <span>Runtime (bootstrap) tools</span>
          <span className="num">{bootstrapTools.length}</span>
        </div>
        <div className="stat-row">
          <span>Routed application tools</span>
          <span className="num">{routedCount}</span>
        </div>
        <div className="stat-row">
          <span>Total active WebMCP tools</span>
          <span className="num">{snapshot.nativeTools.length}</span>
        </div>
        <div className="stat-row">
          <span>Schema bytes on the wire</span>
          <span className="num">{snapshot.schemaBytes.toLocaleString()}</span>
        </div>
        <div className="stat-row">
          <span>Current authority</span>
          <span className="num authority" data-authority>
            {authorityClauses(snapshot.grants).map((parts, clause) => (
              <Fragment key={clause}>
                {clause > 0 ? "; " : null}
                {parts.map((part, index) => (
                  <Fragment key={index}>
                    {index > 0 ? " " : null}
                    <span className="nowrap">{part}</span>
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </span>
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

      {report ? (
        <div className="rail-section routing-decision">
          <h3>Routing decision</h3>
          <p className="decision">
            <strong>{snapshot.catalogSize}</strong> candidates, these{" "}
            <strong>{report.activated.length}</strong>, because
          </p>
          {report.query !== "" ? (
            <p className="query">“{report.query}”</p>
          ) : null}
          <ol
            className="route-matches"
            aria-label="Routed capabilities in rank order"
          >
            {report.matches.map((match) => (
              <li
                key={match.name}
                data-match={match.name}
                className={`match${match.available ? "" : " unavailable"}`}
              >
                <span className="name">{match.name}</span>{" "}
                <span className="score">score {match.score}</span>{" "}
                <span className={`risk ${match.risk}`}>{match.risk}</span>
                {match.requiresApproval ? (
                  <span className="policy">needs approval</span>
                ) : null}
                <div className="availability">
                  {availabilityText(match, report)}
                </div>
                {match.reasonCode !== undefined ? (
                  <div className="why">
                    {match.reasonCode}: {match.reason}
                  </div>
                ) : null}
                {match.suggestedCapability ? (
                  <div className="suggest">
                    Try {match.suggestedCapability} instead.
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="footnote">
            A score adds the weight of each signal that matched: intent{" "}
            {ROUTING_WEIGHTS.intent}, domain {ROUTING_WEIGHTS.domain}, entity{" "}
            {ROUTING_WEIGHTS.entity}, keyword {ROUTING_WEIGHTS.keyword} (up to
            two hits), route {ROUTING_WEIGHTS.route}.
          </p>
        </div>
      ) : null}

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
    </>
  );
}
