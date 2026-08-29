import { Link, useParams } from "react-router-dom";
import { Pill, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { orderTotal, round2 } from "../data/types.ts";

export function OrderDetail() {
  const state = useDemoStore();
  const { mode, id } = useParams();
  const order = state.orders.find((o) => o.id === id);
  if (!order) {
    return (
      <>
        <h1>Order not found</h1>
        <p className="page-sub">
          <Link to={`/${mode}/orders`}>Back to orders</Link>
        </p>
      </>
    );
  }
  const customer = state.customers.find((c) => c.id === order.customerId);
  const invoice = state.invoices.find((inv) => inv.orderId === order.id);
  const subtotal = round2(
    order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );

  return (
    <>
      <div className="detail-header">
        <h1>Order #{order.id}</h1>
        <Pill value={order.status} />
        {order.tags.map((tag) => (
          <span key={tag} className="pill normal">
            {tag}
          </span>
        ))}
      </div>
      <p className="page-sub">
        Placed {fmtDate(order.placedAt)} by{" "}
        <Link to={`/${mode}/customers/${order.customerId}`}>
          {customer?.name ?? order.customerId}
        </Link>
      </p>
      <div className="grid-2">
        <div
          className="panel"
          data-reveal="order-items"
          role="region"
          aria-label={`Items on order #${order.id}`}
        >
          <h2>Items</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Unit</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.sku}>
                  <td>
                    {item.name}
                    <div className="est">{item.sku}</div>
                  </td>
                  <td>{item.quantity}</td>
                  <td>{fmtMoney(item.unitPrice)}</td>
                  <td>{fmtMoney(round2(item.quantity * item.unitPrice))}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3}>Subtotal</td>
                <td>{fmtMoney(subtotal)}</td>
              </tr>
              <tr>
                <td colSpan={3}>
                  Shipping {order.shippingPaid ? "" : "(waived)"}
                </td>
                <td>{order.shippingPaid ? fmtMoney(order.shippingFee) : "$0.00"}</td>
              </tr>
              <tr>
                <td colSpan={3}>
                  <strong>Total</strong>
                </td>
                <td>
                  <strong>{fmtMoney(orderTotal(order))}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <div
            className="panel"
            data-reveal="shipping-summary"
            role="region"
            aria-label={`Shipping summary for order #${order.id}`}
          >
            <h2>Shipping</h2>
            <div className="stat-row">
              <span>Address</span>
              <span className="num">{order.shippingAddress}</span>
            </div>
            <div className="stat-row">
              <span>Carrier</span>
              <span className="num">{order.carrier}</span>
            </div>
            <div className="stat-row">
              <span>Tracking</span>
              <span className="num">{order.trackingNumber ?? "not shipped"}</span>
            </div>
            <div className="stat-row">
              <span>Shipping fee</span>
              <span className="num">
                {order.shippingPaid ? fmtMoney(order.shippingFee) : "free"}
              </span>
            </div>
            <div className="stat-row">
              <span>Shipping refund</span>
              <span className="num">
                {order.shippingRefunded
                  ? `${fmtMoney(order.shippingFee)} · Refunded`
                  : "none"}
              </span>
            </div>
            {order.holdReason ? (
              <div className="stat-row">
                <span>Hold reason</span>
                <span className="num">{order.holdReason}</span>
              </div>
            ) : null}
          </div>
          <div
            className="panel"
            data-reveal="order-billing"
            role="region"
            aria-label={`Billing for order #${order.id}`}
          >
            <h2>Billing</h2>
            {invoice ? (
              <>
                <div className="stat-row">
                  <span>Invoice</span>
                  <span className="num">{invoice.id}</span>
                </div>
                <div className="stat-row">
                  <span>Status</span>
                  <span className="num">
                    <Pill value={invoice.status} />
                  </span>
                </div>
                <div className="stat-row">
                  <span>Total</span>
                  <span className="num">{fmtMoney(invoice.total)}</span>
                </div>
              </>
            ) : (
              <div className="empty">No invoice (cancelled order).</div>
            )}
          </div>
          {order.notes.length > 0 ? (
            <div className="panel">
              <h2>Notes</h2>
              <ul className="note-list">
                {order.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
