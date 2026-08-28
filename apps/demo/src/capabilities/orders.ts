import {
  AVAILABLE,
  CapabilityUnavailableError,
  unavailable,
  type Capability,
} from "@agentdesk/webmcp";
import { getState, mutate } from "../data/store.ts";
import { orderTotal } from "../data/types.ts";
import {
  createReadCapability,
  createSearchCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  obj,
  orderRoute,
  orderSummary,
  requireOrder,
  requireStr,
  s,
  str,
} from "./helpers.ts";

const domain = "orders";

function contextOrder(ctx: { state: Record<string, unknown> }) {
  const id = typeof ctx.state.orderId === "string" ? ctx.state.orderId : undefined;
  return id !== undefined
    ? getState().orders.find((order) => order.id === id)
    : undefined;
}

export const orderCapabilities: Capability[] = [
  createSearchCapability({
    name: "search_orders",
    title: "Search orders",
    description: "Search orders by id, customer name, status, or tag.",
    domain,
    intents: ["find", "search", "look up"],
    keywords: ["order", "status"],
    routes: ["/orders"],
    inputSchema: obj({ query: s("Order id, customer name, status, or tag") }, ["query"]),
    execute: (input) => {
      const query = requireStr(input, "query").toLowerCase().replace(/^#/, "");
      const state = getState();
      const matches = state.orders
        .filter((order) => {
          const customer = state.customers.find((c) => c.id === order.customerId);
          return (
            order.id.includes(query) ||
            order.status.includes(query) ||
            order.tags.some((tag) => tag.toLowerCase().includes(query)) ||
            (customer?.name.toLowerCase().includes(query) ?? false)
          );
        })
        .map(orderSummary);
      return { count: matches.length, orders: matches };
    },
  }),
  createReadCapability({
    name: "inspect_order",
    title: "Inspect order",
    description:
      "Full detail for one order: items, totals, shipping, notes, and status.",
    domain,
    intents: ["inspect order", "order details", "open order"],
    keywords: ["detail", "order"],
    entities: ["orderId"],
    routes: ["/orders/"],
    inputSchema: obj({ order_id: s("Order id, e.g. 10428") }, ["order_id"]),
    presentation: {
      route: orderRoute,
      reveal: "order-items",
      message: (input) => `Opening order #${String(input.order_id ?? "")}`,
    },
    execute: (input) => {
      const order = requireOrder(input);
      return {
        ...orderSummary(order),
        items: order.items,
        shipping_address: order.shippingAddress,
        carrier: order.carrier,
        tracking_number: order.trackingNumber,
        hold_reason: order.holdReason,
        notes: order.notes,
        tags: order.tags,
      };
    },
  }),
  createReadCapability({
    name: "get_order_items",
    title: "Get order items",
    description: "Line items for an order with quantities and unit prices.",
    domain,
    intents: ["order items", "line items"],
    keywords: ["item", "line"],
    entities: ["orderId"],
    routes: ["/orders/"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      return { order_id: order.id, items: order.items };
    },
  }),
  createReadCapability({
    name: "get_order_totals",
    title: "Get order totals",
    description: "Item subtotal, shipping fee, and grand total for an order.",
    domain,
    intents: ["order total", "how much"],
    keywords: ["total", "subtotal", "amount"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      const subtotal = order.items.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        0,
      );
      return {
        order_id: order.id,
        subtotal: Math.round(subtotal * 100) / 100,
        shipping_fee: order.shippingFee,
        shipping_paid: order.shippingPaid,
        total: orderTotal(order),
      };
    },
  }),
  createReadCapability({
    name: "get_order_timeline",
    title: "Get order timeline",
    description: "Chronology of an order: placement, status, and notes.",
    domain,
    intents: ["order timeline", "order history"],
    keywords: ["timeline", "when"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      return {
        order_id: order.id,
        placed_at: order.placedAt,
        status: order.status,
        shipped: order.trackingNumber !== null,
        notes: order.notes,
      };
    },
  }),
  createSearchCapability({
    name: "find_unshipped_orders",
    title: "Find unshipped orders",
    description:
      "Orders still in processing or on hold, optionally for one customer.",
    domain,
    intents: ["unshipped orders", "not shipped", "pending orders"],
    keywords: ["unshipped", "pending", "processing", "order"],
    routes: ["/orders", "/shipping"],
    inputSchema: obj({
      customer: s("Optional customer id or name filter"),
    }),
    presentation: {
      route: () => "/orders",
      reveal: "orders-table",
      message: (input) =>
        input.customer
          ? `Looking for unshipped orders for ${String(input.customer)}`
          : "Looking for unshipped orders",
    },
    execute: (input) => {
      const state = getState();
      const filter = str(input, "customer")?.toLowerCase();
      const matches = state.orders
        .filter((order) => order.status === "processing" || order.status === "on_hold")
        .filter((order) => {
          if (!filter) {
            return true;
          }
          const customer = state.customers.find((c) => c.id === order.customerId);
          return (
            order.customerId.toLowerCase() === filter ||
            (customer?.name.toLowerCase().includes(filter) ?? false)
          );
        })
        .map(orderSummary);
      return { count: matches.length, orders: matches };
    },
  }),
  createReadCapability({
    name: "list_recent_orders",
    title: "List recent orders",
    description: "The most recently placed orders across all customers.",
    domain,
    keywords: ["recent", "latest", "order"],
    routes: ["/orders", "/"],
    inputSchema: obj({ limit: n_limit() }),
    execute: (input) => {
      const limit = typeof input.limit === "number" ? input.limit : 10;
      const orders = [...getState().orders]
        .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
        .slice(0, Math.max(1, Math.min(limit, 50)))
        .map(orderSummary);
      return { orders };
    },
  }),
  createUpdateCapability({
    name: "add_order_note",
    title: "Add order note",
    description: "Append an internal note to an order.",
    domain,
    keywords: ["note", "order"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id"), note: s("Note text") }, [
      "order_id",
      "note",
    ]),
    execute: (input) => {
      const order = requireOrder(input);
      const note = requireStr(input, "note");
      mutate((draft) => {
        draft.orders.find((o) => o.id === order.id)?.notes.push(note);
      });
      return { order_id: order.id, note_added: true };
    },
  }),
  createUpdateCapability({
    name: "tag_order",
    title: "Tag order",
    description: "Add a tag such as 'gift' or 'fragile' to an order.",
    domain,
    keywords: ["tag", "label", "order"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id"), tag: s("Tag to add") }, [
      "order_id",
      "tag",
    ]),
    execute: (input) => {
      const order = requireOrder(input);
      const tag = requireStr(input, "tag");
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target && !target.tags.includes(tag)) {
          target.tags.push(tag);
        }
      });
      return { order_id: order.id, tag_added: tag };
    },
  }),
  createStateTransitionCapability({
    name: "hold_order",
    title: "Hold order",
    description: "Place a processing order on hold with a reason.",
    domain,
    keywords: ["hold", "pause", "order"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && order.status !== "processing") {
        return unavailable(
          "INVALID_STATE",
          `Order ${order.id} is ${order.status}; only processing orders can be held.`,
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id"), reason: s("Why the order is held") }, [
      "order_id",
      "reason",
    ]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status !== "processing") {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Order ${order.id} is ${order.status}; only processing orders can be held.`,
          ),
        );
      }
      const reason = requireStr(input, "reason");
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.status = "on_hold";
          target.holdReason = reason;
        }
      });
      return { order_id: order.id, status: "on_hold", reason };
    },
  }),
  createStateTransitionCapability({
    name: "release_order_hold",
    title: "Release order hold",
    description: "Return an on-hold order to processing.",
    domain,
    keywords: ["release", "hold", "resume", "order"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && order.status !== "on_hold") {
        return unavailable(
          "INVALID_STATE",
          `Order ${order.id} is not on hold.`,
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status !== "on_hold") {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", `Order ${order.id} is not on hold.`),
        );
      }
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.status = "processing";
          target.holdReason = null;
        }
      });
      return { order_id: order.id, status: "processing" };
    },
  }),
  createStateTransitionCapability({
    name: "cancel_order",
    title: "Cancel order",
    description:
      "Cancel an order that has not shipped. Shipped orders need a return instead.",
    domain,
    consequential: true,
    intents: ["cancel order"],
    keywords: ["cancel", "order"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && (order.status === "shipped" || order.status === "delivered")) {
        return unavailable(
          "ORDER_ALREADY_SHIPPED",
          "This order has already shipped and can no longer be cancelled.",
          "create_return",
        );
      }
      if (order && order.status === "cancelled") {
        return unavailable("INVALID_STATE", "This order is already cancelled.");
      }
      return AVAILABLE;
    },
    checkInput: (input) => {
      const id = typeof input.order_id === "string" || typeof input.order_id === "number"
        ? String(input.order_id).replace(/^#/, "")
        : undefined;
      const order = id !== undefined
        ? getState().orders.find((o) => o.id === id)
        : undefined;
      if (order && (order.status === "shipped" || order.status === "delivered")) {
        return unavailable(
          "ORDER_ALREADY_SHIPPED",
          "This order has already shipped and can no longer be cancelled.",
          "create_return",
        );
      }
      if (order && order.status === "cancelled") {
        return unavailable("INVALID_STATE", "This order is already cancelled.");
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id"), reason: s("Cancellation reason") }, [
      "order_id",
    ]),
    presentation: {
      route: orderRoute,
      reveal: "order-items",
      message: (input) =>
        `Preparing to cancel order #${String(input.order_id ?? "")}`,
    },
    describeApproval: (input) =>
      `Cancel order #${String(input.order_id)}. Inventory is released and the invoice is voided.`,
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status === "shipped" || order.status === "delivered") {
        throw new CapabilityUnavailableError(
          unavailable(
            "ORDER_ALREADY_SHIPPED",
            "This order has already shipped and can no longer be cancelled.",
            "create_return",
          ),
        );
      }
      if (order.status === "cancelled") {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", "This order is already cancelled."),
        );
      }
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.status = "cancelled";
        }
        const invoice = draft.invoices.find((i) => i.orderId === order.id);
        if (invoice) {
          invoice.status = "void";
        }
      });
      return { order_id: order.id, status: "cancelled" };
    },
  }),
  createUpdateCapability({
    name: "duplicate_order",
    title: "Duplicate order",
    description: "Create a new processing order with the same items for the same customer.",
    domain,
    keywords: ["duplicate", "reorder", "copy"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id to duplicate") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      let newId = "";
      mutate((draft) => {
        const maxId = Math.max(...draft.orders.map((o) => Number(o.id)));
        newId = String(maxId + 1);
        draft.orders.push({
          ...order,
          id: newId,
          placedAt: new Date().toISOString(),
          status: "processing",
          shippingRefunded: false,
          carrier: "unassigned",
          trackingNumber: null,
          holdReason: null,
          items: order.items.map((item) => ({ ...item })),
          notes: [`Duplicated from order ${order.id}`],
          tags: [...order.tags],
        });
      });
      return { new_order_id: newId, duplicated_from: order.id };
    },
  }),
];

function n_limit() {
  return { type: "number", description: "Max orders to return (default 10)" };
}
