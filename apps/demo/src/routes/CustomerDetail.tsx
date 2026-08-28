import { Link, useParams } from "react-router-dom";
import { Pill, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { orderTotal } from "../data/types.ts";

export function CustomerDetail() {
  const state = useDemoStore();
  const { mode, id } = useParams();
  const customer = state.customers.find((c) => c.id === id);
  if (!customer) {
    return (
      <>
        <h1>Customer not found</h1>
        <p className="page-sub">
          <Link to={`/${mode}/customers`}>Back to customers</Link>
        </p>
      </>
    );
  }
  const orders = state.orders
    .filter((o) => o.customerId === customer.id)
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  const tickets = state.tickets.filter((t) => t.customerId === customer.id);
  const credits = state.credits.filter((c) => c.customerId === customer.id);

  return (
    <>
      <div className="detail-header">
        <h1>{customer.name}</h1>
        {customer.tags.map((tag) => (
          <span key={tag} className="pill normal">
            {tag}
          </span>
        ))}
      </div>
      <p className="page-sub">
        {customer.email} · {customer.phone} · {customer.city}, {customer.country}
      </p>
      <div className="grid-2">
        <div className="panel" data-reveal="customer-orders">
          <h2>Orders</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed</th>
                <th>Status</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link to={`/${mode}/orders/${order.id}`}>#{order.id}</Link>
                  </td>
                  <td>{fmtDate(order.placedAt)}</td>
                  <td>
                    <Pill value={order.status} />
                  </td>
                  <td>{fmtMoney(orderTotal(order))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="panel">
            <h2>Support tickets</h2>
            {tickets.length === 0 ? (
              <div className="empty">No tickets.</div>
            ) : (
              <table className="data">
                <tbody>
                  {tickets.map((ticket) => (
                    <tr key={ticket.id}>
                      <td>{ticket.subject}</td>
                      <td>
                        <Pill value={ticket.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="panel" data-reveal="customer-credits">
            <h2>Credits</h2>
            {credits.length === 0 ? (
              <div className="empty">No credits issued.</div>
            ) : (
              <table className="data">
                <tbody>
                  {credits.map((credit) => (
                    <tr key={credit.id}>
                      <td>{credit.reason}</td>
                      <td>{fmtMoney(credit.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {customer.notes.length > 0 ? (
            <div className="panel">
              <h2>Notes</h2>
              <ul className="note-list">
                {customer.notes.map((note, i) => (
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
