import {
  AVAILABLE,
  CapabilityUnavailableError,
  unavailable,
  type Capability,
  receipt,
} from "@agentdesksdk/webmcp";
import { getState, mutate } from "../data/store.ts";
import { orderTotal } from "../data/types.ts";
import {
  createReadCapability,
  createSearchCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  customerRoute,
  customerSummary,
  obj,
  orderSummary,
  requireCustomer,
  requireStr,
  s,
  str,
} from "./helpers.ts";

const domain = "customers";

export const customerCapabilities: Capability[] = [
  createSearchCapability({
    name: "search_customers",
    title: "Search customers",
    description:
      "Search customers by name, email, or city. Returns matching customer summaries.",
    domain,
    intents: ["find", "search", "look up", "locate", "who is"],
    keywords: ["customer", "name", "email", "person", "client"],
    routes: ["/customers"],
    inputSchema: obj({ query: s("Name, email fragment, or city") }, ["query"]),
    presentation: {
      route: () => "/customers",
      reveal: "customers-table",
      message: (input) => `Searching customers for "${String(input.query ?? "")}"`,
    },
    execute: (input) => {
      const query = requireStr(input, "query").toLowerCase();
      const matches = getState()
        .customers.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.email.toLowerCase().includes(query) ||
            c.city.toLowerCase().includes(query),
        )
        .map(customerSummary);
      return { count: matches.length, customers: matches };
    },
  }),
  createReadCapability({
    name: "get_customer",
    title: "Get customer",
    description: "Full profile for a customer by id or exact name.",
    domain,
    intents: ["customer profile", "customer details"],
    entities: ["customerId"],
    routes: ["/customers/"],
    inputSchema: obj({ customer_id: s("Customer id like C-1001, or exact name") }, [
      "customer_id",
    ]),
    presentation: {
      route: (input) => customerRoute(input),
      reveal: "customer-orders",
      message: (input) => `Opening the profile for ${String(input.customer_id ?? "")}`,
    },
    execute: (input) => {
      const customer = requireCustomer(input);
      return { ...customerSummary(customer), phone: customer.phone, notes: customer.notes };
    },
  }),
  createReadCapability({
    name: "list_customer_orders",
    title: "List customer orders",
    description:
      "All orders for a customer, newest first, with status and shipping fields.",
    domain,
    intents: ["customer orders", "order history", "find order"],
    keywords: ["order", "history", "unshipped"],
    entities: ["customerId"],
    routes: ["/customers/"],
    inputSchema: obj(
      {
        customer_id: s("Customer id like C-1001, or exact name"),
        status: s("Optional status filter: processing, on_hold, shipped, delivered, cancelled"),
      },
      ["customer_id"],
    ),
    presentation: {
      route: (input) => customerRoute(input),
      reveal: "customer-orders",
      message: (input) => `Listing orders for ${String(input.customer_id ?? "")}`,
    },
    execute: (input) => {
      const customer = requireCustomer(input);
      const status = str(input, "status");
      const orders = getState()
        .orders.filter((order) => order.customerId === customer.id)
        .filter((order) => (status ? order.status === status : true))
        .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
        .map(orderSummary);
      return { customer: customer.name, count: orders.length, orders };
    },
  }),
  createReadCapability({
    name: "list_customer_addresses",
    title: "List customer addresses",
    description: "Shipping addresses on file for a customer.",
    domain,
    intents: ["customer address"],
    keywords: ["address", "shipping"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id") }, ["customer_id"]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const addresses = [
        ...new Set(
          getState()
            .orders.filter((order) => order.customerId === customer.id)
            .map((order) => order.shippingAddress),
        ),
      ];
      return { customer: customer.name, addresses };
    },
  }),
  createReadCapability({
    name: "get_customer_lifetime_value",
    title: "Customer lifetime value",
    description: "Total non-cancelled order value for a customer.",
    domain,
    intents: ["lifetime value", "customer spend"],
    keywords: ["value", "spend", "revenue"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id") }, ["customer_id"]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const orders = getState().orders.filter(
        (order) => order.customerId === customer.id && order.status !== "cancelled",
      );
      const total = orders.reduce((sum, order) => sum + orderTotal(order), 0);
      return { customer: customer.name, orders: orders.length, lifetime_value: Math.round(total * 100) / 100 };
    },
  }),
  createUpdateCapability({
    name: "add_customer_note",
    title: "Add customer note",
    description: "Append an internal note to a customer profile.",
    domain,
    intents: ["customer note"],
    keywords: ["note", "remark"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id"), note: s("Note text") }, [
      "customer_id",
      "note",
    ]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const note = requireStr(input, "note");
      mutate((draft) => {
        draft.customers.find((c) => c.id === customer.id)?.notes.push(note);
      });
      return { customer: customer.name, note_added: true };
    },
  }),
  createUpdateCapability({
    name: "tag_customer",
    title: "Tag customer",
    description: "Add a tag such as 'priority' or 'wholesale' to a customer.",
    domain,
    keywords: ["tag", "label"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id"), tag: s("Tag to add") }, [
      "customer_id",
      "tag",
    ]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const tag = requireStr(input, "tag");
      mutate((draft) => {
        const target = draft.customers.find((c) => c.id === customer.id);
        if (target && !target.tags.includes(tag)) {
          target.tags.push(tag);
        }
      });
      return { customer: customer.name, tags_now: [...customer.tags, tag] };
    },
  }),
  createUpdateCapability({
    name: "update_customer_email",
    title: "Update customer email",
    description: "Change the email address on a customer profile.",
    domain,
    keywords: ["email", "contact"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id"), email: s("New email") }, [
      "customer_id",
      "email",
    ]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const email = requireStr(input, "email");
      mutate((draft) => {
        const target = draft.customers.find((c) => c.id === customer.id);
        if (target) {
          target.email = email;
        }
      });
      return { customer: customer.name, email };
    },
  }),
  createUpdateCapability({
    name: "update_customer_phone",
    title: "Update customer phone",
    description: "Change the phone number on a customer profile.",
    domain,
    keywords: ["phone", "contact"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id"), phone: s("New phone number") }, [
      "customer_id",
      "phone",
    ]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const phone = requireStr(input, "phone");
      mutate((draft) => {
        const target = draft.customers.find((c) => c.id === customer.id);
        if (target) {
          target.phone = phone;
        }
      });
      return { customer: customer.name, phone };
    },
  }),
  createStateTransitionCapability({
    name: "merge_customers",
    title: "Merge customers",
    description:
      "Merge a duplicate customer into a primary customer. Moves orders and tickets, then removes the duplicate.",
    domain,
    consequential: true,
    keywords: ["merge", "duplicate"],
    inputSchema: obj(
      {
        primary_id: s("Customer id to keep"),
        duplicate_id: s("Customer id to merge away"),
      },
      ["primary_id", "duplicate_id"],
    ),
    checkInput: (input) => {
      const primary =
        typeof input.primary_id === "string" ? input.primary_id : undefined;
      const duplicate =
        typeof input.duplicate_id === "string" ? input.duplicate_id : undefined;
      if (primary !== undefined && duplicate !== undefined && primary === duplicate) {
        return unavailable(
          "INVALID_INPUT",
          "primary_id and duplicate_id must be different customers; a self-merge would delete the customer.",
        );
      }
      return AVAILABLE;
    },
    describeApproval: (input) =>
      `Merge customer ${String(input.duplicate_id)} into ${String(input.primary_id)}. The duplicate profile is removed.`,
    execute: (input) => {
      const primary = requireCustomer(input, "primary_id");
      const duplicate = requireCustomer(input, "duplicate_id");
      if (primary.id === duplicate.id) {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_INPUT",
            "primary_id and duplicate_id must be different customers; a self-merge would delete the customer.",
          ),
        );
      }
      const movedOrders = getState().orders.filter((o) => o.customerId === duplicate.id).length;
      const movedTickets = getState().tickets.filter((t) => t.customerId === duplicate.id).length;
      mutate((draft) => {
        for (const order of draft.orders) {
          if (order.customerId === duplicate.id) {
            order.customerId = primary.id;
          }
        }
        for (const ticket of draft.tickets) {
          if (ticket.customerId === duplicate.id) {
            ticket.customerId = primary.id;
          }
        }
        draft.customers = draft.customers.filter((c) => c.id !== duplicate.id);
      });
      return receipt({
        entity: `Customer ${primary.name}`,
        changes: [
          { field: `Orders under ${duplicate.name}`, before: movedOrders, after: 0 },
          { field: `Tickets under ${duplicate.name}`, before: movedTickets, after: 0 },
          { field: `Customer ${duplicate.id}`, before: duplicate.name, after: null },
        ],
        evidence: [
          {
            label: `Orders now under ${primary.name}`,
            route: `/customers/${primary.id}`,
            reveal: "customer-orders",
          },
          {
            label: `${duplicate.name} gone from the customer list`,
            route: "/customers",
            reveal: "customers-table",
          },
        ],
        result: { merged_into: primary.id, removed: duplicate.id },
      });
    },
  }),
  createStateTransitionCapability({
    name: "anonymize_customer",
    title: "Anonymize customer",
    description:
      "Irreversibly anonymize a customer's personal data for a deletion request.",
    domain,
    consequential: true,
    keywords: ["anonymize", "gdpr", "privacy", "delete"],
    availability: (ctx) => {
      const id = typeof ctx.state.customerId === "string" ? ctx.state.customerId : undefined;
      if (id !== undefined) {
        const customer = getState().customers.find((c) => c.id === id);
        if (customer?.name.startsWith("Anonymized")) {
          return unavailable(
            "INVALID_STATE",
            "This customer is already anonymized.",
          );
        }
      }
      return AVAILABLE;
    },
    inputSchema: obj({ customer_id: s("Customer id") }, ["customer_id"]),
    describeApproval: (input) =>
      `Anonymize all personal data for customer ${String(input.customer_id)}. This cannot be undone.`,
    execute: (input) => {
      const customer = requireCustomer(input);
      mutate((draft) => {
        const target = draft.customers.find((c) => c.id === customer.id);
        if (target) {
          target.name = `Anonymized ${target.id}`;
          target.email = "removed@example.com";
          target.phone = "removed";
          target.notes = [];
        }
      });
      return receipt({
        entity: `Customer ${customer.id}`,
        changes: [
          { field: "Name", before: customer.name, after: `Anonymized ${customer.id}` },
          { field: "Email", before: customer.email, after: "removed@example.com" },
          { field: "Phone", before: customer.phone, after: "removed" },
        ],
        evidence: [
          {
            label: `Profile of customer ${customer.id}`,
            route: `/customers/${customer.id}`,
            reveal: "customer-profile",
          },
        ],
        result: { customer_id: customer.id, anonymized: true },
      });
    },
  }),
];
