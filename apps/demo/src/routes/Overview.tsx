import { Link, useParams } from "react-router-dom";
import { orderTotal, round2 } from "../data/types.ts";
import { Pill, StatCard, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";

export function Overview() {
  const state = useDemoStore();
  const { mode } = useParams();
  const orders = state.orders.filter((o) => o.status !== "cancelled");
  const revenue = round2(orders.reduce((sum, o) => sum + orderTotal(o), 0));
  const openTickets = state.tickets.filter((t) => t.status !== "closed").length;
  const lowStock = state.products.filter(
    (p) => !p.discontinued && p.stock - p.reserved <= p.reorderPoint,
  ).length;
  const recent = [...state.orders]
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
    .slice(0, 8);

  return (
    <>
      <h1>Overview</h1>
      <p className="page-sub">
        Operations console for the Meridian home-office store. All data is
        fictional and lives in your browser.
      </p>
      <div className="cards">
        <StatCard label="Revenue" value={fmtMoney(revenue)} hint="non-cancelled orders" />
        <StatCard label="Orders" value={orders.length} />
        <StatCard label="Customers" value={state.customers.length} />
        <StatCard label="Open tickets" value={openTickets} />
        <StatCard label="Low-stock SKUs" value={lowStock} />
      </div>
      <div className="panel">
        <h2>Recent orders</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Placed</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((order) => {
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
