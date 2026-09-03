import type { Change, OperationPlan } from "@agentdesksdk/webmcp";
import { OPERATOR, rescue } from "./runtime.ts";

/** The plan's four previews in order: what a person approves, as one list. */
export function consolidated(plan: OperationPlan): Change[] {
  return plan.operations.flatMap((operation) => operation.preview);
}

export const show = (value: unknown) =>
  value === null || value === undefined ? "none" : String(value);

/** Every plan state as words the card carries; the border only echoes it. */
export function stateWords(plan: OperationPlan): string {
  switch (plan.status) {
    case "DRAFT":
      return "awaiting your approval";
    case "APPROVED":
      return "approved, waiting for the agent to commit";
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

/** The operations in a person's words; the capability name sits beside each. */
export const OPERATION_WORDS: Record<string, string> = {
  reserve_oxygen: "Reserve two oxygen packs",
  assign_rescue_drone: "Assign rescue drone NIA-7",
  reroute_dock_power: "Reroute power to Dock 3",
  launch_rescue: "Launch the rescue",
};

const SETTLED = new Set(["COMMITTED", "REJECTED", "PARTIAL", "INTERRUPTED"]);

export function isSettled(plan: OperationPlan): boolean {
  return SETTLED.has(plan.status);
}

/** The plan's body: its operations with their outcomes once known, and its changes. */
function PlanBody({ plan }: { plan: OperationPlan }) {
  const done = plan.status === "COMMITTED";
  return (
    <>
      <p className="summary">{plan.summary}</p>
      <p className="state" data-plan-state>
        {stateWords(plan)}
      </p>
      <ol className="operations" aria-label="Operations in order">
        {plan.operations.map((operation, index) => {
          const outcome = plan.outcomes?.[index];
          return (
            <li key={`${operation.capability}-${index}`} data-operation={operation.capability}>
              <span className="step">{index + 1}</span>
              <span className="what">{OPERATION_WORDS[operation.capability] ?? operation.capability}</span>
              <code className="cap">{operation.capability}</code>
              {outcome ? (
                <span className="outcome">
                  {outcome.status.toLowerCase()}
                  {outcome.verification ? `, ${outcome.verification.status.toLowerCase()}` : ""}
                  {"error" in outcome && typeof outcome.error === "string" ? `: ${outcome.error}` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="will-change">
        <h4>{done ? "What changed" : "What will change"}</h4>
        <p className="evidence">
          {done
            ? "Each line landed and was read back from the console."
            : "Derived from a staged run of all four operations, not from a description of them."}
        </p>
        <ul aria-label={done ? "Changes that landed" : "Consolidated changes"}>
          {consolidated(plan).map((change) => (
            <li key={change.field} className="change-row" data-change={change.field}>
              <span className="field">{change.field}</span>
              <span className="before">{show(change.before)}</span>
              <span className="arrow" aria-hidden="true">
                →
              </span>
              <span className="after">{show(change.after)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/**
 * The one approval. Approve mints a gesture token inside the click and
 * hands it to approvePlan, which moves the plan to APPROVED and nothing
 * else: the agent commits on its next turn. Reject is a plain call. While
 * the plan executes the card blocks input and says so.
 */
export function PlanCard({ plan }: { plan: OperationPlan }) {
  const busy = plan.status === "APPROVED" || plan.status === "COMMITTING";
  const open = plan.status === "DRAFT";
  return (
    <section
      className={`plan-card status-${plan.status}`}
      role={open ? "alertdialog" : "region"}
      aria-label={`Plan ${plan.id}: ${stateWords(plan)}`}
      data-plan={plan.id}
      data-status={plan.status}
    >
      <header>
        <span className="title">Rescue plan {plan.id}</span>
        <span className={`risk ${plan.risk}`}>{plan.risk}</span>
      </header>
      <PlanBody plan={plan} />
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => rescue.rejectPlan(plan.id)}>
          Reject
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-label={busy ? `Plan ${plan.id} approved, waiting for the agent` : `Approve plan ${plan.id}`}
          onClick={() => {
            // The click is the gesture. The token is minted here, in the
            // handler, and consumed by approvePlan; nothing else can mint one.
            rescue.approvePlan(plan.id, rescue.issueApprovalGesture({ planId: plan.id }, OPERATOR));
          }}
        >
          {busy ? "Approved, waiting for the agent" : "Approve plan"}
        </button>
      </div>
    </section>
  );
}

/** A plan that is finished, folded so it does not repeat the receipt. */
export function PlanSettled({ plan }: { plan: OperationPlan }) {
  return (
    <details className={`plan-card settled status-${plan.status}`} data-plan={plan.id} data-status={plan.status}>
      <summary>
        <span className="title">Rescue plan {plan.id}</span>
        <span className="state">{stateWords(plan)}</span>
        <span className={`risk ${plan.risk}`}>{plan.risk}</span>
      </summary>
      <PlanBody plan={plan} />
    </details>
  );
}
