import { useState, useSyncExternalStore } from "react";
import type { AuditEvent, OperationPlan } from "@agentdesksdk/webmcp";
import { AuthorizationOverlay, Confirmation, isSettled, PlanRecord, receiptLines, Recovered, show, stateWords } from "./PlanCard.tsx";
import { Presence } from "./Presence.tsx";
import { getRuntimeSnapshot, resetRescue, subscribeRuntime, webmcpNative } from "./runtime.ts";
import { scene } from "./scene.ts";
import { Scene } from "./Scene.tsx";
import { getState, subscribe } from "./state.ts";

const useRescueState = () => useSyncExternalStore(subscribe, getState);
const useRuntime = () => useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot);
const useScene = () => useSyncExternalStore(scene.subscribe, scene.get);

/** The objective a mission commander gives their WebMCP client. The page only shows it. */
export const TRY_THIS =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

/** The second objective, shown once the rescue has launched. The page only shows it. */
export const COMPLETE_PROMPT = "Complete the Asteria rescue, verify the crew is safe, and show me the final receipt.";

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
      return `plan ${event.planId} authorized by ${event.actor.name ?? event.actor.id}${event.gestureId ? `, gesture ${event.gestureId}` : ""}`;
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

/** Where the plan stands once it is out of the overlay, read from the runtime alone. */
function planStatus(plans: OperationPlan[]): string | null {
  const open = plans.find((plan) => !isSettled(plan));
  if (open?.status === "APPROVED") {
    return `${open.id} authorized. Waiting for the agent to commit.`;
  }
  if (open?.status === "COMMITTING") {
    return `The agent is committing ${open.id}.`;
  }
  const last = plans[plans.length - 1];
  if (last !== undefined && isSettled(last) && last.status !== "COMMITTED") {
    return `${last.id} ${stateWords(last)}.`;
  }
  return null;
}

async function copyPrompt(text: string, setNote: (words: string) => void) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      setNote("Copied. Paste it into your WebMCP client.");
      return;
    }
  } catch {
    // fall through to the words below
  }
  setNote("Select the objective and copy it; the clipboard is not available here.");
}

export function App() {
  const state = useRescueState();
  const snapshot = useRuntime();
  const flags = useScene();
  const [note, setNote] = useState("");
  const plans = snapshot.plans;
  const draft = plans.find((plan) => plan.status === "DRAFT");
  const committed = plans.filter((plan) => plan.status === "COMMITTED");
  const latest = committed[committed.length - 1];
  const connected =
    snapshot.lastRouting !== null || plans.length > 0 || snapshot.audit.some((event) => event.kind === "capability_invoked");
  const status = planStatus(plans);

  const activity = [...snapshot.audit]
    .reverse()
    .map((event) => ({ event, words: eventWords(event) }))
    .filter((row): row is { event: AuditEvent; words: string } => row.words !== null)
    .slice(0, 60);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="name">Asteria: Rescue Protocol</span>
          <span className="sub">powered by AgentDesk</span>
        </div>
        <span className={`agent-status ${connected ? "connected" : "waiting"}`} role="status" aria-live="polite" data-agent-status>
          {connected ? "Agent connected" : "Waiting for a WebMCP agent"}
        </span>
        <div className="controls">
          <button type="button" onClick={() => void resetRescue()}>
            Reset
          </button>
        </div>
      </header>

      <main className="stage" id="main-content">
        <Scene state={state} flags={flags} />
      </main>

      <section className="band" aria-label="Communication and authorization">
        <Presence mode="guided" />
        {status !== null ? (
          <p className="plan-status" role="status" aria-live="polite" data-plan-status>
            {status}
          </p>
        ) : null}
        {flags.completed ? <Recovered audit={snapshot.audit} state={state} /> : null}
        {latest !== undefined ? <Confirmation plan={latest} audit={snapshot.audit} /> : null}
        {state.mission.status === "draft" ? (
          <section className="objective-band" role="region" aria-label="Objective">
            <span className="eyebrow">Objective for your WebMCP client</span>
            <blockquote>{TRY_THIS}</blockquote>
            <div className="actions">
              <button type="button" onClick={() => void copyPrompt(TRY_THIS, setNote)}>
                Copy prompt
              </button>
              <span className="detail" role="status" aria-live="polite">
                {note}
              </span>
            </div>
          </section>
        ) : (
          <section className="objective-band" role="region" aria-label="Next objective">
            <span className="eyebrow">Next objective for your WebMCP client</span>
            <blockquote>{COMPLETE_PROMPT}</blockquote>
            <div className="actions">
              <button type="button" onClick={() => void copyPrompt(COMPLETE_PROMPT, setNote)}>
                Copy prompt
              </button>
              <span className="detail" role="status" aria-live="polite">
                {note}
              </span>
            </div>
          </section>
        )}
      </section>

      {draft !== undefined ? <AuthorizationOverlay plan={draft} /> : null}

      <details className="inspector" data-inspector>
        <summary>AgentDesk Inspector</summary>
        <div className="inspector-grid">
          <section aria-label="Tools">
            <h3>Tools</h3>
            <p className="detail">
              {snapshot.catalogSize} capabilities, {snapshot.nativeTools.length} tools registered, {snapshot.routedTools.length} routed.{" "}
              {webmcpNative
                ? "WebMCP is native in this browser: the tools sit on document.modelContext."
                : "No WebMCP host in this browser: the tools sit in an in-page sink, and a client can drive them from the devtools console through window.rescue.invoke."}
            </p>
            <ul className="tools" aria-label="Registered tools">
              {snapshot.nativeTools.map((tool) => (
                <li key={tool} data-tool={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Routing">
            <h3>Routing</h3>
            {snapshot.lastRouting ? (
              <ol className="matches" aria-label="Routed capabilities in rank order">
                {snapshot.lastRouting.matches.map((match) => (
                  <li key={match.name} data-match={match.name}>
                    <code>{match.name}</code> <span className="score">score {match.score}</span>{" "}
                    <span className={`risk ${match.risk}`}>{match.risk}</span>
                    {match.requiresApproval ? <span className="policy"> needs authorization</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="detail">No task routed yet.</p>
            )}
          </section>
          <section aria-label="Audit">
            <h3>Audit</h3>
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
          <section aria-label="Receipts">
            <h3>Receipts</h3>
            {committed.map((plan) => (
              <div key={plan.id} className="receipt" data-receipt={plan.id}>
                <h4>Receipt {plan.id}</h4>
                <ul aria-label={`Receipt ${plan.id} changes`}>
                  {receiptLines(plan, snapshot.audit).map(({ change, verification }) => (
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
              </div>
            ))}
            {plans.length === 0 ? <p className="detail">No plan yet.</p> : null}
            {plans.map((plan) => (
              <PlanRecord key={plan.id} plan={plan} />
            ))}
          </section>
        </div>
      </details>
    </div>
  );
}
