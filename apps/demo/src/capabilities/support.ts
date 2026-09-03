import {
  AVAILABLE,
  CapabilityUnavailableError,
  unavailable,
  type Capability,
} from "@agentdesksdk/webmcp";
import { getState, mutate, nowIso } from "../data/store.ts";
import {
  createReadCapability,
  createSearchCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  obj,
  requireCustomer,
  requireStr,
  requireTicket,
  s,
  str,
} from "./helpers.ts";

const domain = "support";

/**
 * A ticket thread is written by customers. Every capability that returns
 * one hands the model text nobody on this side authored, and says so, so a
 * note that reads like an instruction arrives labelled as content.
 */
const untrustedContentHint = true;

export const supportCapabilities: Capability[] = [
  createReadCapability({
    name: "list_open_tickets",
    title: "List open tickets",
    description: "Support tickets that are open or pending, highest priority first.",
    domain,
    intents: ["open tickets", "support queue"],
    keywords: ["ticket", "open", "queue", "support"],
    routes: ["/support"],
    untrustedContentHint,
    inputSchema: obj({}),
    execute: () => {
      const weight = { high: 0, normal: 1, low: 2 } as const;
      const tickets = getState()
        .tickets.filter((t) => t.status !== "closed")
        .sort((a, b) => weight[a.priority] - weight[b.priority]);
      return { count: tickets.length, tickets };
    },
  }),
  createReadCapability({
    name: "get_ticket",
    title: "Get ticket",
    description: "One support ticket with its full message thread.",
    domain,
    keywords: ["ticket", "thread"],
    entities: ["ticketId"],
    routes: ["/support"],
    untrustedContentHint,
    inputSchema: obj({ ticket_id: s("Ticket id like T-2001") }, ["ticket_id"]),
    execute: (input) => requireTicket(input),
  }),
  createSearchCapability({
    name: "search_tickets",
    title: "Search tickets",
    description: "Search tickets by subject text or customer.",
    domain,
    keywords: ["ticket", "search", "find"],
    routes: ["/support"],
    untrustedContentHint,
    inputSchema: obj({ query: s("Subject fragment or customer name") }, ["query"]),
    execute: (input) => {
      const query = requireStr(input, "query").toLowerCase();
      const state = getState();
      const tickets = state.tickets.filter((t) => {
        const customer = state.customers.find((c) => c.id === t.customerId);
        return (
          t.subject.toLowerCase().includes(query) ||
          (customer?.name.toLowerCase().includes(query) ?? false)
        );
      });
      return { count: tickets.length, tickets };
    },
  }),
  createReadCapability({
    name: "list_customer_tickets",
    title: "List customer tickets",
    description: "All tickets raised by one customer.",
    domain,
    keywords: ["ticket", "customer"],
    entities: ["customerId"],
    untrustedContentHint,
    inputSchema: obj({ customer_id: s("Customer id") }, ["customer_id"]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const tickets = getState().tickets.filter(
        (t) => t.customerId === customer.id,
      );
      return { customer: customer.name, tickets };
    },
  }),
  createUpdateCapability({
    name: "create_ticket",
    title: "Create ticket",
    description: "Open a new support ticket for a customer.",
    domain,
    keywords: ["ticket", "create", "open"],
    entities: ["customerId"],
    inputSchema: obj(
      {
        customer_id: s("Customer id"),
        subject: s("Ticket subject"),
        priority: s("low, normal, or high (default normal)"),
      },
      ["customer_id", "subject"],
    ),
    execute: (input) => {
      const customer = requireCustomer(input);
      const subject = requireStr(input, "subject");
      const priority = input.priority;
      let ticketId = "";
      mutate((draft) => {
        ticketId = `T-${2001 + draft.tickets.length}`;
        draft.tickets.push({
          id: ticketId,
          customerId: customer.id,
          subject,
          status: "open",
          priority:
            priority === "low" || priority === "high" ? priority : "normal",
          createdAt: nowIso(),
          messages: [
            { from: "customer", text: subject, at: nowIso() },
          ],
        });
      });
      return { ticket_id: ticketId, customer: customer.name };
    },
  }),
  createUpdateCapability({
    name: "reply_to_ticket",
    title: "Reply to ticket",
    description: "Send an agent reply on a ticket thread.",
    domain,
    keywords: ["reply", "respond", "ticket"],
    entities: ["ticketId"],
    inputSchema: obj(
      { ticket_id: s("Ticket id"), message: s("Reply text") },
      ["ticket_id", "message"],
    ),
    execute: (input) => {
      const ticket = requireTicket(input);
      const message = requireStr(input, "message");
      mutate((draft) => {
        draft.tickets
          .find((t) => t.id === ticket.id)
          ?.messages.push({
            from: "agent",
            text: message,
            at: nowIso(),
          });
      });
      return { ticket_id: ticket.id, replied: true };
    },
  }),
  createUpdateCapability({
    name: "create_support_note",
    title: "Create support note",
    description: "Attach an internal note to a ticket, invisible to the customer.",
    domain,
    keywords: ["note", "internal", "ticket"],
    entities: ["ticketId"],
    inputSchema: obj(
      { ticket_id: s("Ticket id"), note: s("Internal note text") },
      ["ticket_id", "note"],
    ),
    execute: (input) => {
      const ticket = requireTicket(input);
      const note = requireStr(input, "note");
      mutate((draft) => {
        draft.tickets
          .find((t) => t.id === ticket.id)
          ?.messages.push({
            from: "agent",
            text: `[internal] ${note}`,
            at: nowIso(),
          });
      });
      return { ticket_id: ticket.id, note_added: true };
    },
    verify: (input) => {
      const ticketId = str(input, "ticket_id");
      const note = str(input, "note");
      if (ticketId === undefined || note === undefined) {
        return { status: "PARTIAL", unverified: ["ticket.messages"] };
      }
      const expected = `[internal] ${note}`;
      const ticket = getState().tickets.find((candidate) => candidate.id === ticketId);
      return ticket?.messages.some(
        (message) => message.from === "agent" && message.text === expected,
      )
        ? { status: "VERIFIED" }
        : {
            status: "MISMATCH",
            field: "ticket.messages",
            expected,
            observed: ticket?.messages ?? null,
          };
    },
  }),
  createUpdateCapability({
    name: "escalate_ticket",
    title: "Escalate ticket",
    description: "Raise a ticket's priority to high.",
    domain,
    keywords: ["escalate", "urgent", "priority"],
    entities: ["ticketId"],
    inputSchema: obj({ ticket_id: s("Ticket id") }, ["ticket_id"]),
    execute: (input) => {
      const ticket = requireTicket(input);
      mutate((draft) => {
        const target = draft.tickets.find((t) => t.id === ticket.id);
        if (target) {
          target.priority = "high";
        }
      });
      return { ticket_id: ticket.id, priority: "high" };
    },
  }),
  createStateTransitionCapability({
    name: "close_ticket",
    title: "Close ticket",
    description: "Close an open or pending ticket.",
    domain,
    keywords: ["close", "resolve", "ticket"],
    entities: ["ticketId"],
    availability: (ctx) => {
      const id = typeof ctx.state.ticketId === "string" ? ctx.state.ticketId : undefined;
      const ticket = id !== undefined ? getState().tickets.find((t) => t.id === id) : undefined;
      if (ticket?.status === "closed") {
        return unavailable(
          "INVALID_STATE",
          "This ticket is already closed.",
          "reopen_ticket",
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ ticket_id: s("Ticket id") }, ["ticket_id"]),
    execute: (input) => {
      const ticket = requireTicket(input);
      if (ticket.status === "closed") {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", "This ticket is already closed.", "reopen_ticket"),
        );
      }
      mutate((draft) => {
        const target = draft.tickets.find((t) => t.id === ticket.id);
        if (target) {
          target.status = "closed";
        }
      });
      return { ticket_id: ticket.id, status: "closed" };
    },
  }),
  createStateTransitionCapability({
    name: "reopen_ticket",
    title: "Reopen ticket",
    description: "Reopen a closed ticket.",
    domain,
    keywords: ["reopen", "ticket"],
    entities: ["ticketId"],
    inputSchema: obj({ ticket_id: s("Ticket id") }, ["ticket_id"]),
    execute: (input) => {
      const ticket = requireTicket(input);
      if (ticket.status !== "closed") {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", "This ticket is not closed."),
        );
      }
      mutate((draft) => {
        const target = draft.tickets.find((t) => t.id === ticket.id);
        if (target) {
          target.status = "open";
        }
      });
      return { ticket_id: ticket.id, status: "open" };
    },
  }),
];
