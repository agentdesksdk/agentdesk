import { getState } from "../data/store.ts";
import { agentdesk } from "../runtime/agentdesk.ts";
import { money } from "../capabilities/helpers.ts";
import { useRuntime } from "./hooks.ts";
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
  if (snapshot.pending.length === 0) {
    return null;
  }
  return (
    <div className="approval-overlay">
      {snapshot.pending.map((action) => (
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
            <dt>Approval id</dt>
            <dd>{action.id}</dd>
          </dl>
          <div className="actions">
            <button
              onClick={() => {
                agentdesk.reject(action.id);
              }}
            >
              Reject
            </button>
            <button
              className="primary"
              onClick={() => {
                void agentdesk.approve(action.id);
              }}
            >
              Approve
            </button>
          </div>
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
