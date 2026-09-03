import { useState, useSyncExternalStore } from "react";
import type { AuditEvent } from "@agentdesksdk/webmcp";
import { PANELS } from "./capabilities.ts";
import { getClientCalls, HERO_PROMPT, runHeroPrompt, subscribeClient, type ClientOutcome } from "./client.ts";
import { PlanCard, show } from "./PlanCard.tsx";
import { Presence, type PresenceMode } from "./Presence.tsx";
import { getRuntimeSnapshot, rescue, resetRescue, subscribeRuntime } from "./runtime.ts";
import { getState, subscribe } from "./state.ts";

const useRescueState = () => useSyncExternalStore(subscribe, getState);
const useRuntime = () => useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot);
const useClient = () => useSyncExternalStore(subscribeClient, getClientCalls);

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function eventWords(event: AuditEvent): string | null {
  switch (event.kind) {
    case "capability_invoked":
      return `${event.capability} invoked`;
    case "plan_prepared":
      return `plan ${event.planId} prepared, ${event.operations.length} operations, ${event.risk}`;
    case "plan_approved":
      return `plan ${event.planId} approved by ${event.actor.name ?? event.actor.id}`;
    case "plan_rejected":
      return `plan ${event.planId} rejected`;
    case "execution_started":
      return `${event.capability} started`;
    case "execution_completed":
      return `${event.capability} completed${event.receipt ? `, ${event.receipt.changes.length} change${event.receipt.changes.length === 1 ? "" : "s"}` : ""}`;
    case "execution_failed":
      return `${event.capability} failed: ${event.error}`;
    case "execution_indeterminate":
      return `${event.capability} outcome unknown, recorded as ${event.recordId}`;
    case "capability_routed":
      return `${event.catalogSize} capabilities searched, ${event.activated.length} activated`;
    default:
      return null;
  }
}

function outcomeWords(outcome: ClientOutcome): string {
  switch (outcome.kind) {
    case "committed":
      return `The agent committed ${outcome.planId} and read back ${outcome.receipts} receipts.`;
    case "rejected":
      return `You rejected ${outcome.planId}; the agent stopped and nothing ran.`;
    case "refused":
      return `The agent stopped at ${outcome.step}: ${outcome.reason}`;
  }
}

export function App() {
  const state = useRescueState();
  const snapshot = useRuntime();
  const calls = useClient();
  const [mode, setMode] = useState<PresenceMode>("guided");
  const [query, setQuery] = useState(HERO_PROMPT);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<string>("");
  const plans = snapshot.plans;
  const committed = plans.filter((plan) => plan.status === "COMMITTED");

  async function propose() {
    setRunning(true);
    setOutcome("");
    try {
      const result = await runHeroPrompt(rescue, query.trim() || HERO_PROMPT);
      setOutcome(outcomeWords(result));
    } finally {
      setRunning(false);
    }
  }

  const activity = [...snapshot.audit]
    .reverse()
    .map((event) => ({ event, words: eventWords(event) }))
    .filter((row): row is { event: AuditEvent; words: string } => row.words !== null)
    .slice(0, 40);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="name">Asteria Rescue Control</span>
          <span className="sub">powered by AgentDesk</span>
        </div>
        <Presence mode={mode} />
        <div className="controls">
          <button
            type="button"
            aria-label={`Presence: ${mode}. Switch to ${mode === "guided" ? "fast" : "guided"}`}
            onClick={() => setMode(mode === "guided" ? "fast" : "guided")}
          >
            Presence: {mode}
          </button>
          <button type="button" onClick={() => void resetRescue()}>
            Reset
          </button>
        </div>
      </header>

      <main className="mission" id="main-content">
        <h1>
          Mission {state.mission.id}
          <span className={`pill mission-${state.mission.status}`} data-mission-status>
            {state.mission.status}
          </span>
        </h1>
        <div className="panels">
          <section className="panel" data-reveal={PANELS.crew} role="region" aria-label={`Crew ${state.crew.name}`}>
            <h2>Crew</h2>
            <div className="value" data-field="crew">
              {state.crew.name}
            </div>
            <div className="detail">
              {state.crew.status} at {state.crew.location}
            </div>
          </section>
          <section className="panel" data-reveal={PANELS.oxygen} role="region" aria-label="Oxygen packs">
            <h2>Oxygen packs</h2>
            <div className="value" data-field="oxygen">
              {state.oxygen.available} available
            </div>
            <div className="detail">{state.oxygen.reserved} reserved for the rescue</div>
          </section>
          <section className="panel" data-reveal={PANELS.drone} role="region" aria-label={`Drone ${state.drone.id}`}>
            <h2>Drone {state.drone.id}</h2>
            <div className="value" data-field="drone">
              {state.drone.status}
            </div>
            <div className="detail">assignment {show(state.drone.assignment)}</div>
          </section>
          <section className="panel" data-reveal={PANELS.dock} role="region" aria-label={`${state.dock.name} power`}>
            <h2>{state.dock.name} power</h2>
            <div className="value" data-field="dock">
              {state.dock.power}%
            </div>
            <div className="detail">{state.dock.power >= 60 ? "enough to receive the rescue" : "below the 60% a rescue needs"}</div>
          </section>
          <section className="panel" data-reveal={PANELS.mission} role="region" aria-label={`Mission ${state.mission.id}`}>
            <h2>Mission {state.mission.id}</h2>
            <div className="value" data-field="mission">
              {state.mission.status}
            </div>
            <div className="detail">{state.mission.status === "launched" ? "the rescue is under way" : "not launched; a launch needs your approval"}</div>
          </section>
        </div>

        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}

        {committed.map((plan) => {
          const receipts = [...rescue.queryReceipts({ planId: plan.id })].reverse();
          return (
            <section key={plan.id} className="receipt" role="region" aria-label={`Rescue receipt ${state.mission.id}`} data-receipt={plan.id}>
              <h2>RESCUE RECEIPT {state.mission.id}</h2>
              <p className="detail">
                Plan {plan.id}, four operations, each read back from the console after it landed.
              </p>
              <ul aria-label="Verified changes">
                {receipts.flatMap((entry) =>
                  entry.receipt.changes.map((change) => (
                    <li key={`${entry.id}-${change.field}`} className="change-row" data-verified={change.field}>
                      <span className="field">{change.field}</span>
                      <span className="before">{show(change.before)}</span>
                      <span className="arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="after">{show(change.after)}</span>
                      <span className="verify">{entry.verification.status.toLowerCase()}</span>
                    </li>
                  )),
                )}
              </ul>
              <p className="detail">
                Retrievable by the agent: <code>invoke_capability</code> with <code>query_receipts</code> and{" "}
                <code>plan_id {plan.id}</code>.
              </p>
            </section>
          );
        })}
      </main>

      <aside className="rail" aria-label="Agent activity">
        <section className="rail-section">
          <h3>Surface</h3>
          <div className="stat-row">
            <span>Capabilities</span>
            <span className="num">{snapshot.catalogSize}</span>
          </div>
          <div className="stat-row">
            <span>Active tools</span>
            <span className="num">{snapshot.nativeTools.length}</span>
          </div>
          <div className="stat-row">
            <span>Routed</span>
            <span className="num">{snapshot.routedTools.length}</span>
          </div>
          <div className="stat-row">
            <span>Pending plans</span>
            <span className="num">{plans.filter((plan) => plan.status === "DRAFT").length}</span>
          </div>
        </section>

        <section className="rail-section">
          <h3>Agent proposal</h3>
          <p className="detail">
            The prompt a WebMCP client would be given. The control below makes the calls that client would make:
            find_capabilities, the reads, prepare_plan through the gateway, then commit_plan once you approve.
          </p>
          <textarea aria-label="Prompt to the agent" rows={5} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button
            type="button"
            className="primary"
            disabled={running}
            aria-label="Propose the rescue: the agent's tool calls for this prompt"
            onClick={() => void propose()}
          >
            {running ? "Agent working…" : "Propose the rescue"}
          </button>
          <p role="status" aria-live="polite" data-client-outcome>
            {outcome}
          </p>
          {calls.length > 0 ? (
            <ol className="calls" aria-label="Tool calls the agent made">
              {calls.map((call, index) => (
                <li key={`${call.tool}-${index}`} data-call={call.name ?? call.tool} className={call.status}>
                  <code>{call.tool}</code>
                  {call.name ? <code className="name"> {call.name}</code> : null}
                  <span className="status"> {call.status}</span>
                  <div className="detail">{call.summary}</div>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <section className="rail-section">
          <h3>Routing decision</h3>
          {snapshot.lastRouting ? (
            <ol className="matches" aria-label="Routed capabilities in rank order">
              {snapshot.lastRouting.matches.map((match) => (
                <li key={match.name} data-match={match.name}>
                  <code>{match.name}</code> <span className="score">score {match.score}</span>{" "}
                  <span className={`risk ${match.risk}`}>{match.risk}</span>
                  {match.requiresApproval ? <span className="policy"> needs approval</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="detail">No task routed yet.</p>
          )}
        </section>

        <section className="rail-section">
          <h3>Activity</h3>
          {activity.length === 0 ? (
            <p className="detail">Nothing yet.</p>
          ) : (
            <ol className="activity" aria-label="Runtime activity, newest first">
              {activity.map(({ event, words }, index) => (
                <li key={`${event.kind}-${event.at}-${index}`} className="event" data-event={event.kind}>
                  <time>{clock(event.at)}</time>
                  <span>{words}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}
