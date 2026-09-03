import { Fragment, useEffect, useRef, useState } from "react";
import { ROUTING_WEIGHTS, type CatalogDomain, type RuntimeSnapshot } from "@agentdesksdk/webmcp";
import { BOOTSTRAP } from "../instrumentation/sideBySide.ts";
import { agentdesk, webmcpNative } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { authorityClauses } from "./grant-text.ts";
import { useRuntime } from "./hooks.ts";
import { UnreconciledPanel } from "./UnreconciledPanel.tsx";

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

/** "3 domains, 79 capabilities" */
function treeSummary(tree: readonly CatalogDomain[]): string {
  const total = tree.reduce((sum, domain) => sum + domain.capabilities, 0);
  return `${tree.length} domain${tree.length === 1 ? "" : "s"}, ${total} capabilit${
    total === 1 ? "y" : "ies"
  }`;
}

const capabilitiesText = (count: number) => `${count} capabilit${count === 1 ? "y" : "ies"}`;

export function Inspector() {
  const snapshot = useRuntime();
  const [query, setQuery] = useState("");
  /**
   * The catalog's domains, held from the first of two calls until the
   * person routes directly again. `find_capabilities` answers with the
   * tree on every first-level call, so the tree is on the report after the
   * single call too; it is shown only when a person asked for it, so the
   * single call reads as it always did.
   */
  const [tree, setTree] = useState<CatalogDomain[] | null>(null);
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
    const tools = `${report.activated.length} active tool${report.activated.length === 1 ? "" : "s"}`;
    announce(
      report.domain !== undefined
        ? `Routed within domain ${report.domain} to ${tools}.`
        : `Routed ${snapshot.catalogSize} candidates to ${tools}.`,
    );
  }, [snapshot.lastRouting, snapshot.catalogSize, announce]);

  /** The first of two calls: the same find_capabilities, and its tree kept for the person to choose from. */
  async function showDomains() {
    await agentdesk.routeTask(query.trim());
    setTree(agentdesk.getSnapshot().lastRouting?.domains ?? []);
  }

  /** The second call: find_capabilities with the domain the person chose, the way a client sends it. */
  async function narrowTo(domain: string) {
    await agentdesk.invoke("find_capabilities", { query: query.trim(), domain });
  }

  const appTools = snapshot.nativeTools.filter((name) => !BOOTSTRAP.has(name));
  const bootstrapTools = snapshot.nativeTools.filter((name) =>
    BOOTSTRAP.has(name),
  );
  const report = snapshot.lastRouting;
  // Read on every snapshot, like the rail does; a receipt with an empty
  // evidence list is a write nobody can be shown.
  const receipts = agentdesk.queryReceipts();
  const receiptsWithProof = receipts.filter(
    (entry) => (entry.receipt.evidence ?? []).length > 0,
  ).length;

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
          <span>Receipts with proof</span>
          <span className="num" data-evidence>
            {receiptsWithProof} of {receipts.length}
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

      <UnreconciledPanel />

      <div className="rail-section">
        <h3>Route a task</h3>
        <form
          className="route-task"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim() !== "") {
              setTree(null);
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
          <button
            type="button"
            aria-label="Show domains: the catalog's tree, to choose one before ranking"
            onClick={() => void showDomains()}
          >
            Show domains
          </button>
        </form>
      </div>

      {tree !== null ? (
        <div className="rail-section domain-tree" role="region" aria-label="Domains in the catalog">
          <h3>Domains</h3>
          <p className="decision">
            {treeSummary(tree)}. Choose one to rank inside it; a second call
            then answers with that domain&apos;s capabilities only.
          </p>
          <ul className="domains" aria-label="Domains, with a count each">
            {tree.map((domain) => {
              const chosen = report?.domain === domain.name;
              return (
                <li key={domain.name} data-domain={domain.name} className={`domain${chosen ? " chosen" : ""}`}>
                  <div className="head">
                    <span className="name">{domain.name}</span>{" "}
                    <span className="count">{capabilitiesText(domain.capabilities)}</span>
                    {chosen ? <span className="state"> · chosen</span> : null}
                  </div>
                  <div className="description">{domain.description}</div>
                  {domain.subdomains !== undefined ? (
                    <ul className="subdomains" aria-label={`Subdomains of ${domain.name}`}>
                      {domain.subdomains.map((sub) => {
                        const path = `${domain.name}/${sub.name}`;
                        return (
                          <li key={sub.name} data-domain={path}>
                            <span className="name">{sub.name}</span>{" "}
                            <span className="count">{capabilitiesText(sub.capabilities)}</span>
                            {report?.domain === path ? <span className="state"> · chosen</span> : null}{" "}
                            <button
                              type="button"
                              className="undo"
                              aria-label={`Narrow to ${path}, ${sub.capabilities} capabilities`}
                              onClick={() => void narrowTo(path)}
                            >
                              Narrow to {sub.name}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    className="undo"
                    aria-label={`Narrow to ${domain.name}, ${domain.capabilities} capabilities`}
                    onClick={() => void narrowTo(domain.name)}
                  >
                    Narrow to {domain.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {report ? (
        <div className="rail-section routing-decision">
          <h3>Routing decision</h3>
          {report.domain !== undefined ? (
            <p className="within">
              Within domain <strong>{report.domain}</strong>, the second of two calls.
            </p>
          ) : null}
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
