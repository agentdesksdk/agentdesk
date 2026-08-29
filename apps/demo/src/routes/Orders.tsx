import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pill, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { orderTotal } from "../data/types.ts";

const STATUSES = ["all", "processing", "on_hold", "shipped", "delivered", "cancelled"];

export function Orders() {
  const state = useDemoStore();
  const { mode } = useParams();
  const [status, setStatus] = useState("all");
  const orders = [...state.orders]
    .filter((o) => status === "all" || o.status === status)
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  return (
    <>
      <h1>Orders</h1>
      <p className="page-sub">{state.orders.length} orders total.</p>
      <div className="panel" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {STATUSES.map((option) => (
          <button
            key={option}
            className={status === option ? "primary" : ""}
            onClick={() => setStatus(option)}
          >
            {option.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <div
        className="panel"
        data-reveal="orders-table"
        role="region"
        aria-label="Orders"
      >
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Placed</th>
              <th>Status</th>
              <th>Shipping</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
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
                  <td>
                    {order.shippingPaid ? fmtMoney(order.shippingFee) : "free"}
                    {order.shippingRefunded ? " · refunded" : ""}
                  </td>
                  <td>{fmtMoney(orderTotal(order))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
