import { Link, useParams } from "react-router-dom";
import { Pill, StatCard, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";

export function Shipping() {
  const state = useDemoStore();
  const { mode } = useParams();
  const pending = state.orders
    .filter((o) => o.status === "processing" || o.status === "on_hold")
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt));
  const inTransit = state.orders.filter((o) => o.status === "shipped");
  const refunded = state.orders.filter((o) => o.shippingRefunded);

  return (
    <>
      <h1>Shipping</h1>
      <p className="page-sub">Fulfillment queue and carrier activity.</p>
      <div className="cards">
        <StatCard label="Awaiting shipment" value={pending.length} />
        <StatCard label="In transit" value={inTransit.length} />
        <StatCard
          label="Shipping refunds"
          value={fmtMoney(refunded.reduce((sum, o) => sum + o.shippingFee, 0))}
          hint={`${refunded.length} order${refunded.length === 1 ? "" : "s"}`}
        />
      </div>
      <div
        className="panel"
        data-reveal="pending-shipments"
        role="region"
        aria-label="Orders awaiting shipment"
      >
        <h2>Awaiting shipment</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Placed</th>
              <th>Status</th>
              <th>Destination</th>
              <th>Shipping fee</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((order) => {
              const customer = state.customers.find((c) => c.id === order.customerId);
              return (
                <tr key={order.id}>
                  <td>
                    <Link to={`/${mode}/orders/${order.id}`}>#{order.id}</Link>
                  </td>
                  <td>{customer?.name ?? order.customerId}</td>
                  <td>{fmtDate(order.placedAt)}</td>
                  <td>
                    <Pill value={order.status} />
                  </td>
                  <td>{order.shippingAddress}</td>
                  <td>
                    {order.shippingPaid ? fmtMoney(order.shippingFee) : "free"}
                    {order.shippingRefunded ? " · refunded" : ""}
                  </td>
                </tr>
              );
            })}
            {pending.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  Nothing waiting to ship.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>In transit</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Carrier</th>
              <th>Tracking</th>
            </tr>
          </thead>
          <tbody>
            {inTransit.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link to={`/${mode}/orders/${order.id}`}>#{order.id}</Link>
                </td>
                <td>{order.carrier}</td>
                <td>{order.trackingNumber}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
