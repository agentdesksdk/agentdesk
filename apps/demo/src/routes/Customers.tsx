import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useDemoStore } from "../components/hooks.ts";

export function Customers() {
  const state = useDemoStore();
  const { mode } = useParams();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const customers = state.customers.filter(
    (c) =>
      q === "" ||
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.city.toLowerCase().includes(q),
  );

  return (
    <>
      <h1>Customers</h1>
      <p className="page-sub">{state.customers.length} customers on file.</p>
      <div className="panel">
        <input
          type="text"
          name="customer-filter"
          aria-label="Filter customers"
          placeholder="Filter by name, email, or city…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="panel" data-reveal="customers-table">
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Email</th>
              <th>Location</th>
              <th>Segment</th>
              <th>Orders</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id}>
                <td>
                  <Link to={`/${mode}/customers/${customer.id}`}>
                    {customer.name}
                  </Link>
                </td>
                <td>{customer.email}</td>
                <td>
                  {customer.city}, {customer.country}
                </td>
                <td>{customer.segment}</td>
                <td>
                  {state.orders.filter((o) => o.customerId === customer.id).length}
                </td>
              </tr>
            ))}
            {customers.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No customers match “{filter}”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
