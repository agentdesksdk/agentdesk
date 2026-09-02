import { getState } from "../data/store.ts";
import { agentdesk, OPERATOR } from "../runtime/agentdesk.ts";
import { money } from "../capabilities/helpers.ts";
import { projectedConflicts } from "../capabilities/staged.ts";
import { consideredGrantText } from "./grant-text.ts";
import { useDemoStore, useRuntime } from "./hooks.ts";
import type { PendingAction } from "@agentdesk/webmcp";

function detailRows(action: PendingAction): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const orderId =
    typeof action.input.order_id === "string" || typeof action.input.order_id === "number"
      ? String(action.input.order_id).replace(/^#/, "")
      : undefined;
  if (orderId !== undefined) {
    const order = getState().orders.find((o) => o.id === orderId);
    rows.push(["Order", `#${orderId}`]);
    if (order) {
      const customer = getState().customers.find((c) => c.id === order.customerId);
      if (customer) {
        rows.push(["Customer", customer.name]);
      }
      if (action.capability === "refund_shipping") {
        rows.push(["Amount", money(order.shippingFee)]);
        rows.push([
          "Reason",
          order.shippingPaid && order.status === "processing"
            ? "Customer paid shipping and the order has not shipped."
            : `Order status: ${order.status}.`,
        ]);
      }
    }
  }
  for (const [key, value] of Object.entries(action.input)) {
    if (key === "order_id") {
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      rows.push([key.replace(/_/g, " "), String(value)]);
    }
  }
  rows.push(["Risk", `${action.risk} / requires human approval`]);
  return rows;
}

export function ApprovalCards() {
  const snapshot = useRuntime();
  useDemoStore();
  if (snapshot.pending.length === 0) {
    return null;
  }
  return (
    <div className="approval-overlay">
      {snapshot.pending.map((action) => {
        // A grant that did not apply fell through to this card. The runtime
        // set it on the action at the request; naming it tells the person
        // what the mandate stopped at, not just that one exists.
        const considered = action.grant;
        const grant =
          considered === undefined
            ? undefined
            : snapshot.grants.find((g) => g.id === considered.id);
        return (
        <div key={action.id} className="approval-card" role="alertdialog">
          <header>
            <span className="title">Approval required</span>
            <span className={`risk ${action.risk}`}>{action.risk}</span>
          </header>
          <div className="summary">{action.summary}</div>
          <dl>
            <dt>Action</dt>
            <dd>{action.capability}</dd>
            {detailRows(action).map(([label, value]) => (
              <FragmentRow key={label + value} label={label} value={value} />
            ))}
            {considered !== undefined ? (
              <>
                <dt>Grant</dt>
                <dd className="considered-grant">
                  {consideredGrantText(considered, grant)}
                </dd>
              </>
            ) : null}
            <dt>Approval id</dt>
            <dd>{action.id}</dd>
          </dl>
          {action.preview.length > 0 ? (
            <div className="will-change">
              <h4>What will change</h4>
              <p className="evidence">
                Read off a staged run of this action, not a description of it.
              </p>
              {action.preview.map((change) => (
                <div key={change.field} className="change-row">
                  <span className="field">{change.field}</span>
                  <span className="before">{render(change.before)}</span>
                  <span className="arrow">→</span>
                  <span className="after">{render(change.after)}</span>
                </div>
              ))}
            </div>
          ) : null}
          <Conflicts capability={action.capability} />
          <div className="actions">
            <button
              onClick={() => {
                agentdesk.reject(action.id, OPERATOR);
              }}
            >
              Reject
            </button>
            <button
              className="primary"
              onClick={() => {
                // The click is the gesture. The token is minted here, in the
                // handler, and consumed by approve; nothing else can mint one.
                void agentdesk.approve(
                  action.id,
                  agentdesk.issueApprovalGesture({ actionId: action.id }, OPERATOR),
                );
              }}
            >
              Approve
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}

export function render(value: unknown): string {
  if (value === null || value === undefined) {
    return "none";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return String(value);
}

function Conflicts({ capability }: { capability: string }) {
  const conflicts = projectedConflicts(capability);
  if (conflicts.length === 0) {
    return null;
  }
  return (
    <div className="conflicts">
      <h4>You have edited this since the agent proposed it</h4>
      {conflicts.map((conflict) => (
        <div key={conflict.key + conflict.field} className="change-row">
          <span className="field">{`${conflict.key} ${conflict.field}`}</span>
          <span className="before">{render(conflict.agent)}</span>
          <span className="arrow">blocks approval</span>
          <span className="after">{render(conflict.human)}</span>
        </div>
      ))}
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
