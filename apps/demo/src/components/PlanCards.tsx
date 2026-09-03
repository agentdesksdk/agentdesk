import { agentdesk, OPERATOR } from "../runtime/agentdesk.ts";
import { useRuntime } from "./hooks.ts";
import { render } from "./ApprovalCards.tsx";

/** Human approval surface for plans prepared through the WebMCP gateway. */
export function PlanCards() {
  const snapshot = useRuntime();
  const plans = snapshot.plans.filter((plan) => plan.status === "DRAFT");
  if (plans.length === 0) {
    return null;
  }
  return (
    <div className="approval-overlay" data-plan-approvals>
      {plans.map((plan) => (
        <div key={plan.id} className="approval-card" role="alertdialog">
          <header>
            <span className="title">Plan approval required</span>
            <span className={`risk ${plan.risk}`}>{plan.risk}</span>
          </header>
          <div className="summary">{plan.summary}</div>
          <dl>
            <dt>Plan</dt>
            <dd>{plan.id}</dd>
            <dt>Operations</dt>
            <dd>{plan.operations.length}</dd>
          </dl>
          <div className="will-change">
            <h4>What will change</h4>
            <p className="evidence">
              One approval covers this ordered plan. No operation runs until
              the approved plan is committed.
            </p>
            {plan.operations.flatMap((operation, index) =>
              operation.preview.length === 0
                ? [
                    <div className="change-row" key={`${index}-read`}>
                      <span className="field">{operation.capability}</span>
                      <span className="after">read only</span>
                    </div>,
                  ]
                : operation.preview.map((change) => (
                    <div className="change-row" key={`${index}-${change.field}`}>
                      <span className="field">
                        {operation.capability}: {change.field}
                      </span>
                      <span className="before">{render(change.before)}</span>
                      <span className="arrow">→</span>
                      <span className="after">{render(change.after)}</span>
                    </div>
                  )),
            )}
          </div>
          <div className="actions">
            <button onClick={() => agentdesk.rejectPlan(plan.id)}>Reject</button>
            <button
              className="primary"
              onClick={() => {
                agentdesk.approvePlan(
                  plan.id,
                  agentdesk.issueApprovalGesture({ planId: plan.id }, OPERATOR),
                );
              }}
            >
              Approve plan
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
