import { Link, useParams } from "react-router-dom";
import { Pill, StatCard, fmtDate } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";

export function Support() {
  const state = useDemoStore();
  const { mode } = useParams();
  const weight = { high: 0, normal: 1, low: 2 } as const;
  const tickets = [...state.tickets].sort(
    (a, b) =>
      (a.status === "closed" ? 1 : 0) - (b.status === "closed" ? 1 : 0) ||
      weight[a.priority] - weight[b.priority],
  );

  return (
    <>
      <h1>Support</h1>
      <p className="page-sub">
        {state.tickets.filter((t) => t.status !== "closed").length} open or
        pending tickets.
      </p>
      <div className="cards">
        <StatCard
          label="Open"
          value={state.tickets.filter((t) => t.status === "open").length}
        />
        <StatCard
          label="Pending"
          value={state.tickets.filter((t) => t.status === "pending").length}
        />
        <StatCard
          label="High priority"
          value={
            state.tickets.filter(
              (t) => t.priority === "high" && t.status !== "closed",
            ).length
          }
        />
      </div>
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Subject</th>
              <th>Customer</th>
              <th>Opened</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => {
              const customer = state.customers.find((c) => c.id === ticket.customerId);
              return (
                <tr key={ticket.id}>
                  <td>
                    <Link to={`/${mode}/support/${ticket.id}`}>{ticket.id}</Link>
                  </td>
                  <td>{ticket.subject}</td>
                  <td>
                    <Link to={`/${mode}/customers/${ticket.customerId}`}>
                      {customer?.name ?? ticket.customerId}
                    </Link>
                  </td>
                  <td>{fmtDate(ticket.createdAt)}</td>
                  <td>
                    <Pill value={ticket.priority} />
                  </td>
                  <td>{ticket.assignee ?? "Unassigned"}</td>
                  <td>
                    <Pill value={ticket.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
