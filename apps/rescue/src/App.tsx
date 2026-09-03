import { useState, useSyncExternalStore } from "react";
import type { AuditEvent, OperationPlan, Receipt } from "@agentdesksdk/webmcp";
import { PANELS } from "./capabilities.ts";
import { isSettled, PlanCard, PlanSettled, show } from "./PlanCard.tsx";
import { Presence, type PresenceMode } from "./Presence.tsx";
import { getRuntimeSnapshot, resetRescue, subscribeRuntime, webmcpNative } from "./runtime.ts";
import { getState, subscribe } from "./state.ts";

const useRescueState = () => useSyncExternalStore(subscribe, getState);
const useRuntime = () => useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot);

/** The prompt a person gives their WebMCP client. The page only shows it. */
export const TRY_THIS =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function eventWords(event: AuditEvent): string | null {
  switch (event.kind) {
    case "capability_routed":
      return `an agent routed a task: ${event.catalogSize} capabilities searched, ${event.activated.length} activated`;
    case "capability_invoked":
      return `${event.capability} invoked by the agent`;
    case "plan_prepared":
      return `plan ${event.planId} prepared by the agent, ${event.operations.length} operations, ${event.risk}`;
    case "plan_approved":
      return `plan ${event.planId} approved by ${event.actor.name ?? event.actor.id}${event.gestureId ? `, gesture ${event.gestureId}` : ""}`;
    case "plan_rejected":
      return `plan ${event.planId} rejected`;
    case "plan_committed":
      return `plan ${event.planId} committed by the agent, ${event.outcomes.length} operations`;
    case "plan_failed":
      return `plan ${event.planId} stopped`;
    case "plan_drifted":
      return `plan ${event.planId} refused: the mission changed since it was reviewed`;
    case "execution_started":
      return `${event.capability} started`;
    case "execution_completed":
      return `${event.capability} completed${event.receipt ? `, ${event.receipt.changes.length} change${event.receipt.changes.length === 1 ? "" : "s"}` : ""}`;
    case "execution_failed":
      return `${event.capability} failed: ${event.error}`;
    case "execution_indeterminate":
      return `${event.capability} outcome unknown, recorded as ${event.recordId}`;
    default:
      return null;
  }
}

/** Where the workflow stands, read from the runtime alone. */
function agentStatus(plans: OperationPlan[], routed: boolean): string {
  const open = plans.find((plan) => !isSettled(plan));
  if (open?.status === "DRAFT") {
    return `An agent staged ${open.id}. It waits for your approval.`;
  }
  if (open?.status === "APPROVED") {
    return `${open.id} is approved. Waiting for the agent's next turn to commit it.`;
  }
  if (open?.status === "COMMITTING") {
    return `The agent is committing ${open.id}.`;
  }
  const last = plans[plans.length - 1];
  if (last?.status === "COMMITTED") {
    return `${last.id} committed. The rescue is under way.`;
  }
  if (last !== undefined) {
    return `${last.id} ${last.status.toLowerCase()}. Waiting for a WebMCP agent.`;
  }
  if (routed) {
    return "An agent routed a task. Waiting for it to stage a plan.";
  }
  return "Waiting for a WebMCP agent.";
}

/** The receipt's lines for a committed plan: each landed operation's receipt, with its verification. */
function receiptLines(plan: OperationPlan, audit: readonly AuditEvent[]) {
  const receipts = new Map<string, Receipt>();
  for (const event of audit) {
    if (event.kind === "execution_completed" && event.receipt !== undefined) {
      receipts.set(event.executionId, event.receipt);
    }
  }
  return (plan.outcomes ?? []).flatMap((outcome) => {
    const receipt = outcome.executionId !== undefined ? receipts.get(outcome.executionId) : undefined;
    return (receipt?.changes ?? []).map((change) => ({ change, verification: outcome.verification.status.toLowerCase() }));
  });
}

async function copyPrompt(setNote: (words: string) => void) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(TRY_THIS);
      setNote("Copied. Paste it into your WebMCP client.");
      return;
    }
  } catch {
    // fall through to the words below
  }
  setNote("Select the prompt above and copy it; the clipboard is not available here.");
}

export function App() {
  const state = useRescueState();
  const snapshot = useRuntime();
  const [mode, setMode] = useState<PresenceMode>("guided");
  const [note, setNote] = useState("");
  const plans = snapshot.plans;
  const openPlans = plans.filter((plan) => !isSettled(plan));
  const settledPlans = plans.filter(isSettled);
  const committed = settledPlans.filter((plan) => plan.status === "COMMITTED");
  const status = agentStatus(plans, snapshot.lastRouting !== null);

  const activity = [...snapshot.audit]
    .reverse()
    .map((event) => ({ event, words: eventWords(event) }))
    .filter((row): row is { event: AuditEvent; words: string } => row.words !== null)
    .slice(0, 40);

  const ready = {
    oxygen: state.oxygen.reserved >= 2,
    drone: state.drone.assignment === state.mission.id,
    dock: state.dock.power >= 60,
    launched: state.mission.status === "launched",
  };

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
        <div className="mission-head">
          <h1>
            Mission {state.mission.id}
            <span className={`pill mission-${state.mission.status}`} data-mission-status>
              {state.mission.status}
            </span>
          </h1>
          <p className="agent-status" role="status" aria-live="polite" data-agent-status>
            {status}
          </p>
        </div>

        {committed.map((plan) => {
          const lines = receiptLines(plan, snapshot.audit);
          return (
            <section key={plan.id} className="receipt" role="region" aria-label={`Rescue receipt ${state.mission.id}`} data-receipt={plan.id}>
              <h2>RESCUE RECEIPT {state.mission.id}</h2>
              <p className="detail">Plan {plan.id}, four operations, each read back from the console after it landed.</p>
              <ul aria-label="Verified changes">
                {lines.map(({ change, verification }) => (
                  <li key={change.field} className="change-row" data-verified={change.field}>
                    <span className="field">{change.field}</span>
                    <span className="before">{show(change.before)}</span>
                    <span className="arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="after">{show(change.after)}</span>
                    <span className="verify">{verification}</span>
                  </li>
                ))}
              </ul>
              <p className="detail">
                The agent reads the same four back with <code>invoke_capability</code> → <code>query_receipts</code>,{" "}
                <code>plan_id {plan.id}</code>.
              </p>
            </section>
          );
        })}

        <div className="mission-grid">
          <section className="panel crew" data-reveal={PANELS.crew} role="region" aria-label={`Crew ${state.crew.name}`}>
            <h2>Crew</h2>
            <div className="value" data-field="crew">
              {state.crew.name}
            </div>
            <div className="detail">
              {state.crew.status} at {state.crew.location}
            </div>
          </section>

          <section className="readiness" role="region" aria-label="Rescue readiness">
            <h2>Rescue readiness</h2>
            <div className="panel row" data-reveal={PANELS.oxygen} role="region" aria-label="Oxygen packs">
              <span className={`mark ${ready.oxygen ? "met" : "unmet"}`}>{ready.oxygen ? "ready" : "needs"}</span>
              <span className="label">Oxygen packs</span>
              <span className="value" data-field="oxygen">
                {state.oxygen.available} available
              </span>
              <span className="detail">{state.oxygen.reserved} of 2 reserved for the rescue</span>
            </div>
            <div className="panel row" data-reveal={PANELS.drone} role="region" aria-label={`Drone ${state.drone.id}`}>
              <span className={`mark ${ready.drone ? "met" : "unmet"}`}>{ready.drone ? "ready" : "needs"}</span>
              <span className="label">Drone {state.drone.id}</span>
              <span className="value" data-field="drone">
                {state.drone.status}
              </span>
              <span className="detail">assignment {show(state.drone.assignment)}</span>
            </div>
            <div className="panel row" data-reveal={PANELS.dock} role="region" aria-label={`${state.dock.name} power`}>
              <span className={`mark ${ready.dock ? "met" : "unmet"}`}>{ready.dock ? "ready" : "needs"}</span>
              <span className="label">{state.dock.name} power</span>
              <span className="value" data-field="dock">
                {state.dock.power}%
              </span>
              <span className="detail">{ready.dock ? "enough to receive the rescue" : "60% needed to receive the rescue"}</span>
            </div>
            <div className="panel row" data-reveal={PANELS.mission} role="region" aria-label={`Mission ${state.mission.id}`}>
              <span className={`mark ${ready.launched ? "met" : "unmet"}`}>{ready.launched ? "done" : "held"}</span>
              <span className="label">Launch</span>
              <span className="value" data-field="mission">
                {state.mission.status}
              </span>
              <span className="detail">{ready.launched ? "the rescue is under way" : "a launch needs your approval"}</span>
            </div>
          </section>
        </div>

        {openPlans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
        {settledPlans.map((plan) => (
          <PlanSettled key={plan.id} plan={plan} />
        ))}

        <section className="try-this" role="region" aria-label="Try this">
          <h2>Try this</h2>
          <p className="detail">Give this prompt to a WebMCP client connected to this page. The page shows what the client does and asks you before anything launches.</p>
          <blockquote>{TRY_THIS}</blockquote>
          <div className="actions">
            <button type="button" onClick={() => void copyPrompt(setNote)}>
              Copy prompt
            </button>
            <span className="detail" role="status" aria-live="polite">
              {note}
            </span>
          </div>
          <p className="detail">
            {webmcpNative
              ? "WebMCP is native in this browser: the tools are registered on document.modelContext."
              : "No WebMCP host in this browser: the tools are registered into an in-page sink, and a client can drive them from the devtools console through window.rescue.invoke."}
          </p>
        </section>
      </main>

      <aside className="rail" aria-label="Agent activity">
        <details className="rail-section inspector">
          <summary>Inspector</summary>
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
            <span>WebMCP</span>
            <span className="num">{webmcpNative ? "native" : "simulated in-page"}</span>
          </div>
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
        </details>

        <section className="rail-section">
          <h3>Activity</h3>
          {activity.length === 0 ? (
            <p className="detail">Nothing yet. Events appear here as the runtime records them.</p>
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
