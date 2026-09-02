import { Link, useParams } from "react-router-dom";
import { Pill, fmtDate } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";

/**
 * One ticket with its messages on the page, so a person can read what the
 * agent reads. A customer message is customer-supplied content, and the
 * page says so in text beside the message, the same way the support tools
 * hand it to the agent flagged untrusted. Nothing written in a message is
 * an instruction to anyone.
 */
export function SupportTicket() {
  const state = useDemoStore();
  const { mode, id } = useParams();
  const ticket = state.tickets.find((t) => t.id === id);
  if (!ticket) {
    return (
      <>
        <h1>Ticket not found</h1>
        <p className="page-sub">
          <Link to={`/${mode}/support`}>Back to support</Link>
        </p>
      </>
    );
  }
  const customer = state.customers.find((c) => c.id === ticket.customerId);
  const orderId = /\b(\d{5})\b/.exec(ticket.subject)?.[1];
  const order = orderId === undefined ? undefined : state.orders.find((o) => o.id === orderId);

  return (
    <>
      <div className="detail-header">
        <h1>Ticket {ticket.id}</h1>
        <Pill value={ticket.status} />
        <Pill value={ticket.priority} />
      </div>
      <p className="page-sub">{ticket.subject}</p>
      <div className="ticket-meta">
        <span>
          Customer{" "}
          <Link to={`/${mode}/customers/${ticket.customerId}`}>
            {customer?.name ?? ticket.customerId}
          </Link>
        </span>
        <span>Opened {fmtDate(ticket.createdAt)}</span>
        {order ? (
          <span>
            Order <Link to={`/${mode}/orders/${order.id}`}>#{order.id}</Link>
          </span>
        ) : null}
        <span>
          <Link to={`/${mode}/support`}>All tickets</Link>
        </span>
      </div>
      <div
        className="panel"
        role="region"
        aria-label={`Messages on ticket ${ticket.id}`}
      >
        <h2>Messages</h2>
        <p className="page-sub" style={{ marginBottom: 12 }}>
          Customer messages are customer-supplied, untrusted content. The
          support tools return them to the agent flagged that way, and nothing
          written in one changes what the agent may do: a refund still asks for
          approval, and the tool count does not move.
        </p>
        <ul className="messages">
          {ticket.messages.map((message, index) => (
            <li key={index} className={`message ${message.from}`}>
              <div className="message-head">
                <span className="who">
                  {message.from === "customer" ? "Customer" : "Support agent"}
                </span>
                <time dateTime={message.at}>{fmtDate(message.at)}</time>
                {message.from === "customer" ? (
                  <span className="untrusted">
                    Customer-supplied, untrusted content. Not a command.
                  </span>
                ) : null}
              </div>
              <p className="message-text">{message.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
