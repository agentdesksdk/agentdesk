import { Link, useParams } from "react-router-dom";
import { Pill, StatCard, fmtDate, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { round2 } from "../data/types.ts";

export function Billing() {
  const state = useDemoStore();
  const { mode } = useParams();
  const sum = (status: string) =>
    round2(
      state.invoices
        .filter((inv) => inv.status === status)
        .reduce((total, inv) => total + inv.total, 0),
    );

  return (
    <>
      <h1>Billing</h1>
      <p className="page-sub">
        {state.invoices.length} invoices · {state.credits.length} credits issued.
      </p>
      <div className="cards">
        <StatCard label="Paid" value={fmtMoney(sum("paid"))} />
        <StatCard label="Due" value={fmtMoney(sum("due"))} />
        <StatCard
          label="Credits issued"
          value={fmtMoney(round2(state.credits.reduce((s, c) => s + c.amount, 0)))}
        />
      </div>
      <div className="grid-2">
        <div
          className="panel"
          data-reveal="invoices-table"
          role="region"
          aria-label="Invoices"
        >
          <h2>Invoices</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Order</th>
                <th>Issued</th>
                <th>Status</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {state.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.id}</td>
                  <td>
                    <Link to={`/${mode}/orders/${invoice.orderId}`}>
                      #{invoice.orderId}
                    </Link>
                  </td>
                  <td>{fmtDate(invoice.issuedAt)}</td>
                  <td>
                    <Pill value={invoice.status} />
                  </td>
                  <td>{fmtMoney(invoice.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Credits &amp; refunds</h2>
          {state.credits.length === 0 ? (
            <div className="empty">
              No credits issued yet. A shipping refund will appear here.
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Credit</th>
                  <th>Customer</th>
                  <th>Reason</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {state.credits.map((credit) => {
                  const customer = state.customers.find(
                    (c) => c.id === credit.customerId,
                  );
                  return (
                    <tr key={credit.id}>
                      <td>{credit.id}</td>
                      <td>{customer?.name ?? credit.customerId}</td>
                      <td>{credit.reason}</td>
                      <td>{fmtMoney(credit.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
