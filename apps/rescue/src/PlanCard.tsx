import type { AuditEvent, Change, OperationPlan, Receipt } from "@agentdesksdk/webmcp";
import { COMPLETE_RESCUE, rescueCapabilities } from "./capabilities.ts";
import { OPERATOR, rescue } from "./runtime.ts";
import { CREW, DRONE, MISSION, rows, type RescueState } from "./state.ts";

/** The plan's four previews in order: what a person authorizes, as one list. */
export function consolidated(plan: OperationPlan): Change[] {
  return plan.operations.flatMap((operation) => operation.preview);
}

export const show = (value: unknown) =>
  value === null || value === undefined ? "none" : String(value);

/** Every plan state as words; the border only echoes it. */
export function stateWords(plan: OperationPlan): string {
  switch (plan.status) {
    case "DRAFT":
      return "awaiting your authorization";
    case "APPROVED":
      return "authorized, waiting for the agent to commit";
    case "COMMITTING":
      return "executing, one operation at a time";
    case "COMMITTED":
      return "committed, every operation verified";
    case "REJECTED":
      return "rejected, nothing ran";
    case "PARTIAL":
      return "stopped part way: an operation failed, and the ones after it did not run";
    case "INTERRUPTED":
      return "interrupted: an operation's outcome is unknown, and the ones after it did not run";
    default:
      return String(plan.status).toLowerCase();
  }
}

/** The operations in a person's words. */
export const OPERATION_WORDS: Record<string, string> = {
  reserve_oxygen: "Reserve two oxygen packs",
  assign_rescue_drone: "Assign rescue drone NIA-7",
  reroute_dock_power: "Reroute power to Dock 3",
  launch_rescue: "Launch the rescue",
};

const riskOf = (capability: string) => rescueCapabilities.find((c) => c.name === capability)?.risk;

const SETTLED = new Set(["COMMITTED", "REJECTED", "PARTIAL", "INTERRUPTED"]);

export function isSettled(plan: OperationPlan): boolean {
  return SETTLED.has(plan.status);
}

function ChangeRows({ changes, label }: { changes: Array<{ change: Change; verification?: string }>; label: string }) {
  return (
    <ul aria-label={label}>
      {changes.map(({ change, verification }) => (
        <li key={change.field} className="change-row" data-change={change.field}>
          <span className="field">{change.field}</span>
          <span className="before">{show(change.before)}</span>
          <span className="arrow" aria-hidden="true">
            →
          </span>
          <span className="after">{show(change.after)}</span>
          {verification !== undefined ? <span className="verify">{verification}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The one authorization, a centred overlay. Authorize mints a gesture token
 * inside the click and hands it to approvePlan, which moves the plan to
 * APPROVED and nothing else: the agent commits on its next turn. Reject is
 * a plain call. The overlay exists only while the plan is a draft.
 */
export function AuthorizationOverlay({ plan }: { plan: OperationPlan }) {
  return (
    <div className="overlay-backdrop">
      <section className="overlay" role="alertdialog" aria-modal="true" aria-label="Mission authorization required" data-plan={plan.id}>
        <h2>MISSION AUTHORIZATION REQUIRED</h2>
        <p className="objective" data-objective>
          {plan.summary}
        </p>
        <ol className="checklist" aria-label="Operations in order">
          {plan.operations.map((operation, index) => {
            const consequential = riskOf(operation.capability) === "CONSEQUENTIAL";
            return (
              <li key={`${operation.capability}-${index}`} data-operation={operation.capability}>
                <span className="step">{index + 1}</span>
                <span className="what">{OPERATION_WORDS[operation.capability] ?? operation.capability}</span>
                {consequential ? <span className="risk CONSEQUENTIAL">consequential</span> : null}
              </li>
            );
          })}
        </ol>
        <h3>Expected changes</h3>
        <ChangeRows label="Expected changes" changes={consolidated(plan).map((change) => ({ change }))} />
        <div className="actions">
          <button type="button" onClick={() => rescue.rejectPlan(plan.id)}>
            Reject mission
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              // The click is the gesture. The token is minted here, in the
              // handler, and consumed by approvePlan; nothing else can mint one.
              rescue.approvePlan(plan.id, rescue.issueApprovalGesture({ planId: plan.id }, OPERATOR));
            }}
          >
            Authorize rescue
          </button>
        </div>
      </section>
    </div>
  );
}

/** Each landed operation's receipt, joined to the plan's outcome by executionId. */
export function receiptLines(plan: OperationPlan, audit: readonly AuditEvent[]) {
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

/** The compact confirmation after a commit, with the exact receipt behind one control. */
export function Confirmation({ plan, audit }: { plan: OperationPlan; audit: readonly AuditEvent[] }) {
  const outcomes = plan.outcomes ?? [];
  const completed = outcomes.filter((o) => o.status === "COMPLETED").length;
  const verified = outcomes.filter((o) => o.verification.status === "VERIFIED").length;
  return (
    <section className="confirmation" role="region" aria-label="Rescue launched" data-confirmation={plan.id}>
      <h2>RESCUE LAUNCHED</h2>
      <p className="line">
        {DRONE} is en route to {CREW}
      </p>
      <p className="counts">
        {completed} operations completed · {verified} outcomes verified · Receipt {plan.id}
      </p>
      <details className="evidence" data-evidence>
        <summary>View evidence</summary>
        <ChangeRows label="Verified changes" changes={receiptLines(plan, audit)} />
        <ol className="operations" aria-label="Operations and outcomes">
          {plan.operations.map((operation, index) => {
            const outcome = outcomes[index];
            return (
              <li key={`${operation.capability}-${index}`} data-operation={operation.capability}>
                <code>{operation.capability}</code>
                {outcome ? (
                  <span className="outcome">
                    {outcome.status.toLowerCase()}, {outcome.verification.status.toLowerCase()}
                    {outcome.executionId ? `, execution ${outcome.executionId}` : ""}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}

/**
 * The final confirmation, after the completion capability has landed: the receipt the
 * runtime recorded for that execution, each change read back against live
 * state by the page itself. Rendered only when the scene's completed flag
 * is on, which turns on at the capability's completion event.
 */
export function Recovered({ audit, state }: { audit: readonly AuditEvent[]; state: RescueState }) {
  const landed = [...audit].reverse().find(
    (event): event is Extract<AuditEvent, { kind: "execution_completed" }> =>
      event.kind === "execution_completed" && event.capability === COMPLETE_RESCUE && event.receipt !== undefined,
  );
  if (landed === undefined) {
    return null;
  }
  const observed = rows(state);
  const lines = landed.receipt!.changes.map((change) => ({
    change,
    verification: observed[change.field] === change.after ? "matches" : "differs",
  }));
  return (
    <section className="confirmation recovered" role="region" aria-label="Crew recovered" data-recovered={landed.executionId}>
      <h2>CREW RECOVERED</h2>
      <p className="line">
        The {CREW} crew is safe aboard {DRONE}. Mission {MISSION} complete.
      </p>
      <p className="counts">
        {lines.length} changes read back · Execution {landed.executionId}
      </p>
      <details className="evidence" data-evidence>
        <summary>View evidence</summary>
        <ChangeRows label="Changes read back" changes={lines} />
        <ol className="operations" aria-label="Operation and outcome">
          <li data-operation={COMPLETE_RESCUE}>
            <code>{COMPLETE_RESCUE}</code>
            <span className="outcome">completed, execution {landed.executionId}, entity {landed.receipt!.entity}</span>
          </li>
        </ol>
      </details>
    </section>
  );
}

/** A plan in the Inspector: its operations with their outcomes once known, and its changes. */
export function PlanRecord({ plan }: { plan: OperationPlan }) {
  return (
    <details className={`plan-record status-${plan.status}`} data-plan={plan.id} data-status={plan.status}>
      <summary>
        <span className="title">{plan.id}</span> <span className="state">{stateWords(plan)}</span>{" "}
        <span className={`risk ${plan.risk}`}>{plan.risk}</span>
      </summary>
      <p className="summary">{plan.summary}</p>
      <ol className="operations" aria-label={`Operations of ${plan.id}`}>
        {plan.operations.map((operation, index) => {
          const outcome = plan.outcomes?.[index];
          return (
            <li key={`${operation.capability}-${index}`} data-operation={operation.capability}>
              <code>{operation.capability}</code>
              {outcome ? (
                <span className="outcome">
                  {outcome.status.toLowerCase()}, {outcome.verification.status.toLowerCase()}
                  {"error" in outcome && typeof outcome.error === "string" ? `: ${outcome.error}` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <ChangeRows label={`Changes of ${plan.id}`} changes={consolidated(plan).map((change) => ({ change }))} />
    </details>
  );
}
