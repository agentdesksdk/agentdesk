import { useState, useSyncExternalStore } from "react";
import type { Change, OperationPlan } from "@agentdesksdk/webmcp";
import { RESCUE_PLAN } from "./capabilities.ts";
import { getRuntimeSnapshot, OPERATOR, rescue, resetRescue, subscribeRuntime } from "./runtime.ts";
import { getState, subscribe } from "./state.ts";

const useRescueState = () => useSyncExternalStore(subscribe, getState);
const useRuntime = () => useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot);

/** The plan's four previews in order: what a person approves, as one list. */
export function consolidated(plan: OperationPlan): Change[] {
  return plan.operations.flatMap((operation) => operation.preview);
}

const show = (value: unknown) => (value === null || value === undefined ? "none" : String(value));

/**
 * Phase 1: the thinnest page that shows the slice working. No styling; the
 * mission's values, the rail's routing, a stand-in for the agent's plan,
 * the one plan card, and the receipt.
 */
export function App() {
  const state = useRescueState();
  const snapshot = useRuntime();
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const plans = rescue.listPlans();

  async function prepare() {
    setNote("");
    try {
      const plan = await rescue.prepare({
        operations: RESCUE_PLAN,
        summary: `Rescue the ${state.crew.name} crew: reserve two oxygen packs, assign ${state.drone.id}, reroute power to ${state.dock.name}, launch ${state.mission.id}.`,
      });
      setNote(`Plan ${plan.id} prepared; nothing has changed yet.`);
    } catch (error) {
      setNote(`Could not prepare the plan: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function approve(plan: OperationPlan) {
    setBusy(plan.id);
    try {
      const approved = rescue.approvePlan(plan.id, OPERATOR);
      if (!approved.ok) {
        setNote(`Not approved: ${approved.reason}`);
        return;
      }
      const committed = await rescue.commitPlan(plan.id);
      setNote(committed.ok ? `Plan ${plan.id} committed.` : `Commit refused: ${committed.reason}`);
    } finally {
      setBusy(null);
    }
  }

  function reject(plan: OperationPlan) {
    const outcome = rescue.rejectPlan(plan.id);
    setNote(outcome.ok ? `Plan ${plan.id} rejected; nothing changed.` : `Not rejected: ${outcome.reason}`);
  }

  return (
    <main>
      <h1>Asteria Rescue Control</h1>
      <button type="button" onClick={() => void resetRescue()}>
        Reset
      </button>

      <section aria-label="Mission state">
        <h2>Mission state</h2>
        <table>
          <tbody>
            <tr>
              <th>Crew</th>
              <td data-field="crew">
                {state.crew.name}, {state.crew.status}, {state.crew.location}
              </td>
            </tr>
            <tr>
              <th>Oxygen packs</th>
              <td data-field="oxygen">
                available {state.oxygen.available}, reserved {state.oxygen.reserved}
              </td>
            </tr>
            <tr>
              <th>Drone {state.drone.id}</th>
              <td data-field="drone">
                {state.drone.status}, assignment {show(state.drone.assignment)}
              </td>
            </tr>
            <tr>
              <th>{state.dock.name} power</th>
              <td data-field="dock">{state.dock.power}%</td>
            </tr>
            <tr>
              <th>Mission {state.mission.id}</th>
              <td data-field="mission">{state.mission.status}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section aria-label="Route a task">
        <h2>Route a task</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim() !== "") {
              void rescue.routeTask(query.trim());
            }
          }}
        >
          <input aria-label="Task to route" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="submit">Route</button>
        </form>
        <p>
          Active tools: {snapshot.nativeTools.length} ({snapshot.routedTools.length} routed)
        </p>
        {snapshot.lastRouting ? (
          <ol aria-label="Routed capabilities in rank order">
            {snapshot.lastRouting.matches.map((match) => (
              <li key={match.name} data-match={match.name}>
                {match.name} score {match.score} {match.risk}
                {match.requiresApproval ? " needs approval" : ""}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section aria-label="Agent stand-in">
        <h2>Agent stand-in</h2>
        <p>
          Phase 1 has no client attached. This button sends the four-operation plan the hero prompt
          asks for, the way an agent would through the runtime.
        </p>
        <button type="button" onClick={() => void prepare()}>
          Prepare the rescue plan
        </button>
        <p role="status" aria-live="polite" data-note>
          {note}
        </p>
      </section>

      {plans
        .filter((plan) => plan.status === "DRAFT")
        .map((plan) => (
          <section key={plan.id} role="region" aria-label={`Plan approval ${plan.id}`} data-plan={plan.id}>
            <h2>
              Plan {plan.id}: {plan.risk}
            </h2>
            <p>{plan.summary}</p>
            <ol aria-label="Operations in order">
              {plan.operations.map((operation, index) => (
                <li key={`${operation.capability}-${index}`}>
                  {operation.capability} {JSON.stringify(operation.input)}
                </li>
              ))}
            </ol>
            <h3>What will change</h3>
            <ul aria-label="Consolidated changes">
              {consolidated(plan).map((change) => (
                <li key={change.field} data-change={change.field}>
                  {change.field}: {show(change.before)} → {show(change.after)}
                </li>
              ))}
            </ul>
            <button type="button" disabled={busy !== null} onClick={() => reject(plan)}>
              Reject
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void approve(plan)}>
              {busy === plan.id ? "Executing…" : "Approve"}
            </button>
          </section>
        ))}

      {plans
        .filter((plan) => plan.status !== "DRAFT")
        .map((plan) => {
          const receipts = [...rescue.queryReceipts({ planId: plan.id })].reverse();
          return (
            <section key={plan.id} role="region" aria-label={`Rescue receipt ${plan.id}`} data-receipt={plan.id}>
              <h2>
                Plan {plan.id}: {plan.status}
              </h2>
              <ul aria-label="Verified changes">
                {receipts.flatMap((entry) =>
                  entry.receipt.changes.map((change) => (
                    <li key={`${entry.id}-${change.field}`} data-verified={change.field}>
                      {change.field}: {show(change.before)} → {show(change.after)} ({entry.verification.status})
                    </li>
                  )),
                )}
              </ul>
              <ol aria-label="Operation outcomes">
                {(plan.outcomes ?? []).map((outcome, index) => (
                  <li key={`${outcome.capability}-${index}`}>
                    {outcome.capability}: {outcome.status}, verification {outcome.verification.status}
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
    </main>
  );
}
