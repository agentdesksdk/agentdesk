import {
  AVAILABLE,
  CapabilityUnavailableError,
  receipt,
  unavailable,
  type Capability,
  type Change,
} from "@agentdesk/webmcp";
import { getState, mutate, nowIso } from "../data/store.ts";
import {
  createReadCapability,
  createSearchCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  findOrder,
  money,
  obj,
  orderRoute,
  orderSummary,
  requireOrder,
  requireStr,
  s,
} from "./helpers.ts";
import type { Invoice, Order } from "../data/types.ts";

const domain = "shipping";

function refundBlocker(order: Order) {
  if (order.status === "cancelled") {
    return unavailable(
      "INVALID_STATE",
      `Order ${order.id} is cancelled; refund the payment instead.`,
      "refund_payment",
    );
  }
  if (!order.shippingPaid) {
    return unavailable(
      "SHIPPING_NOT_PAID",
      `Order ${order.id} had free shipping; there is no shipping fee to refund.`,
      "issue_credit",
    );
  }
  if (order.shippingRefunded) {
    return unavailable(
      "ALREADY_REFUNDED",
      `The ${money(order.shippingFee)} shipping fee for order ${order.id} has already been refunded.`,
    );
  }
  return null;
}

function orderFromInput(input: Record<string, unknown>): Order | undefined {
  const raw = input.order_id;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return undefined;
  }
  return findOrder(String(raw));
}

function contextOrder(ctx: { state: Record<string, unknown> }) {
  const id = typeof ctx.state.orderId === "string" ? ctx.state.orderId : undefined;
  return id !== undefined
    ? getState().orders.find((order) => order.id === id)
    : undefined;
}

export const shippingCapabilities: Capability[] = [
  createReadCapability({
    name: "get_order_shipping",
    title: "Get order shipping",
    description:
      "Shipping detail for an order: fee, whether it was paid, refund state, carrier, and tracking.",
    domain,
    intents: ["order shipping", "shipping status", "paid shipping"],
    keywords: ["shipping", "fee", "paid", "order"],
    entities: ["orderId"],
    routes: ["/orders/", "/shipping"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    presentation: {
      route: orderRoute,
      reveal: "shipping-summary",
      message: (input) =>
        `Checking whether shipping was paid on order #${String(input.order_id ?? "")}`,
    },
    execute: (input) => {
      const order = requireOrder(input);
      return {
        order_id: order.id,
        status: order.status,
        shipping_fee: order.shippingFee,
        shipping_paid: order.shippingPaid,
        shipping_refunded: order.shippingRefunded,
        shipping_address: order.shippingAddress,
        carrier: order.carrier,
        tracking_number: order.trackingNumber,
      };
    },
  }),
  createStateTransitionCapability({
    name: "refund_shipping",
    title: "Refund shipping",
    description:
      "Refund the shipping fee for an order where the customer paid shipping. Requires human approval.",
    domain,
    consequential: true,
    // Mints a credit id from the number of existing credits, so a branch
    // prepared before the human issued one would mint a duplicate. Re-derive
    // against current state at approval instead of merging the stale write.
    commitMode: "rederive",
    intents: ["refund shipping", "refund fee", "refund the shipping fee"],
    keywords: ["refund", "shipping", "fee", "money"],
    entities: ["orderId"],
    routes: ["/orders/"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order) {
        const blocker = refundBlocker(order);
        if (blocker) {
          return blocker;
        }
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
      return (order && refundBlocker(order)) || AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id, e.g. 10428") }, ["order_id"]),
    presentation: {
      route: orderRoute,
      reveal: "shipping-summary",
      focus: "on_explicit_request",
      announce: (input) => {
        const order = orderFromInput(input);
        return order
          ? `Shipping refund of ${money(order.shippingFee)} applied to order ${order.id}. The shipping summary now shows the refunded fee.`
          : "Shipping refund applied. The shipping summary now shows the refunded fee.";
      },
      message: (input) =>
        `Preparing a shipping refund for order #${String(input.order_id ?? "")}`,
    },
    describeApproval: (input) => {
      const id = String(input.order_id ?? "?");
      const order = getState().orders.find((o) => o.id === id.replace(/^#/, ""));
      const customer = order
        ? getState().customers.find((c) => c.id === order.customerId)
        : undefined;
      return order
        ? `Refund ${money(order.shippingFee)} shipping for Order #${order.id} (${customer?.name ?? "unknown customer"}).`
        : `Refund shipping for Order #${id}.`;
    },
    verify: (input) => {
      const order = orderFromInput(input);
      if (!order) {
        return { status: "PARTIAL", unverified: ["shipping_refunded"] };
      }
      return order.shippingRefunded
        ? { status: "VERIFIED" }
        : {
            status: "MISMATCH",
            field: "shipping_refunded",
            expected: true,
            observed: false,
          };
    },
    // `verify` asks whether the refund is still applied, which only detects
    // an undo that did nothing. This asks the question that matters after an
    // undo, whether the recorded before-state is actually back.
    verifyRollback: (input, _ctx, changes) => {
      const order = orderFromInput(input);
      if (!order) {
        return { status: "PARTIAL", unverified: ["shipping_refunded"] };
      }
      const refundChange = changes.find((c) => c.field === "shipping_refunded");
      const expected = refundChange ? refundChange.before === true : false;
      return order.shippingRefunded === expected
        ? { status: "VERIFIED" }
        : {
            status: "MISMATCH",
            field: "shipping_refunded",
            expected,
            observed: order.shippingRefunded,
          };
    },
    // Restores from the values the receipt recorded, not from guesses about
    // what the prior state must have been.
    rollback: (input, _ctx, changes) => {
      const order = orderFromInput(input);
      if (!order) {
        throw new Error(`Order #${String(input.order_id ?? "?")} no longer exists.`);
      }
      const invoiceChange = changes.find((c) => /^Invoice .+ status$/.test(c.field));
      const creditChange = changes.find((c) => c.field === "Credit issued");
      const creditId =
        typeof creditChange?.after === "string"
          ? creditChange.after.split(" ")[0]
          : undefined;
      // Checked and written inside one mutate so nothing can move between
      // reading the current state and overwriting it.
      mutate((draft) => {
        const invoice = draft.invoices.find((i) => i.orderId === order.id);
        if (invoiceChange && invoice && invoice.status !== invoiceChange.after) {
          throw new Error(
            `Invoice ${invoice.id} is now ${invoice.status}, not ${String(invoiceChange.after)} as the receipt recorded; something else changed it.`,
          );
        }
        if (creditId && !draft.credits.some((c) => c.id === creditId)) {
          throw new Error(
            `Credit ${creditId} is already gone, so this refund has been reversed elsewhere.`,
          );
        }
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.shippingRefunded = false;
        }
        if (invoice && typeof invoiceChange?.before === "string") {
          invoice.status = invoiceChange.before as Invoice["status"];
        }
        if (creditId) {
          draft.credits = draft.credits.filter((c) => c.id !== creditId);
        }
      });
      return { order_id: order.id, shipping_refunded: false };
    },
    execute: (input) => {
      const order = requireOrder(input);
      const blocker = refundBlocker(order);
      if (blocker) {
        throw new CapabilityUnavailableError(blocker);
      }
      const invoiceBefore = getState().invoices.find(
        (inv) => inv.orderId === order.id,
      );
      let creditId = "";
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.shippingRefunded = true;
        }
        const invoice = draft.invoices.find((i) => i.orderId === order.id);
        if (invoice) {
          invoice.status = "partially_refunded";
        }
        creditId = `CR-${4001 + draft.credits.length}`;
        draft.credits.push({
          id: creditId,
          customerId: order.customerId,
          amount: order.shippingFee,
          reason: `Shipping refund for order ${order.id}`,
          issuedAt: nowIso(),
        });
      });
      const changes: Change[] = [
        {
          field: `Order #${order.id} shipping refunded`,
          before: false,
          after: true,
        },
        {
          field: "Credit issued",
          before: null,
          after: `${creditId} · ${money(order.shippingFee)}`,
        },
      ];
      if (invoiceBefore) {
        changes.push({
          field: `Invoice ${invoiceBefore.id} status`,
          before: invoiceBefore.status,
          after: "partially_refunded",
        });
      }
      return receipt({
        entity: `Order #${order.id}`,
        changes,
        undoable: true,
        affected: [
          {
            kind: "order",
            id: order.id,
            label: `Order #${order.id}`,
            reveal: "shipping-summary",
          },
        ],
        note: "Reversible: rolling back clears the credit and restores the invoice.",
        result: {
          order_id: order.id,
          shipping_refunded: true,
          amount: order.shippingFee,
        },
      });
    },
  }),
  createReadCapability({
    name: "get_shipping_rates",
    title: "Get shipping rates",
    description: "Flat-rate shipping options currently offered at checkout.",
    domain,
    keywords: ["rate", "cost", "shipping"],
    routes: ["/shipping"],
    inputSchema: obj({}),
    execute: () => ({
      rates: [
        { service: "Standard", fee: 9, days: "5-7" },
        { service: "Extended", fee: 12, days: "3-5" },
        { service: "Express", fee: 18, days: "1-2" },
      ],
    }),
  }),
  createReadCapability({
    name: "estimate_delivery",
    title: "Estimate delivery",
    description: "Estimated delivery window for an order based on its carrier.",
    domain,
    keywords: ["delivery", "eta", "when", "arrive"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      const days =
        order.status === "delivered"
          ? "delivered"
          : order.status === "shipped"
            ? "2-4 days"
            : "5-9 days after dispatch";
      return { order_id: order.id, status: order.status, estimate: days };
    },
  }),
  createReadCapability({
    name: "track_shipment",
    title: "Track shipment",
    description: "Tracking number and carrier for a shipped order.",
    domain,
    intents: ["track", "where is"],
    keywords: ["track", "tracking", "shipment"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.trackingNumber === null) {
        throw new CapabilityUnavailableError(
          unavailable(
            "ORDER_NOT_SHIPPED",
            `Order ${order.id} has not shipped yet, so there is nothing to track.`,
            "estimate_delivery",
          ),
        );
      }
      return {
        order_id: order.id,
        carrier: order.carrier,
        tracking_number: order.trackingNumber,
        status: order.status,
      };
    },
  }),
  createSearchCapability({
    name: "list_pending_shipments",
    title: "List pending shipments",
    description: "Orders waiting to be shipped, oldest first.",
    domain,
    intents: ["pending shipments", "to ship"],
    keywords: ["pending", "queue", "shipment"],
    routes: ["/shipping"],
    inputSchema: obj({}),
    presentation: {
      route: () => "/shipping",
      reveal: "pending-shipments",
      message: "Reviewing the fulfillment queue",
    },
    execute: () => {
      const orders = getState()
        .orders.filter((order) => order.status === "processing")
        .sort((a, b) => a.placedAt.localeCompare(b.placedAt))
        .map(orderSummary);
      return { count: orders.length, orders };
    },
  }),
  createUpdateCapability({
    name: "update_shipping_address",
    title: "Update shipping address",
    description: "Change the shipping address on an order that has not shipped.",
    domain,
    keywords: ["address", "change", "shipping"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && (order.status === "shipped" || order.status === "delivered")) {
        return unavailable(
          "ORDER_ALREADY_SHIPPED",
          "The order has already shipped; the address can no longer change.",
          "create_return",
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id"), address: s("New address") }, [
      "order_id",
      "address",
    ]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status === "shipped" || order.status === "delivered") {
        throw new CapabilityUnavailableError(
          unavailable(
            "ORDER_ALREADY_SHIPPED",
            "The order has already shipped; the address can no longer change.",
            "create_return",
          ),
        );
      }
      const address = requireStr(input, "address");
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.shippingAddress = address;
        }
      });
      return { order_id: order.id, shipping_address: address };
    },
  }),
  createUpdateCapability({
    name: "assign_carrier",
    title: "Assign carrier",
    description: "Assign a delivery carrier to a processing order.",
    domain,
    keywords: ["carrier", "assign", "courier"],
    entities: ["orderId"],
    inputSchema: obj(
      { order_id: s("Order id"), carrier: s("Carrier name") },
      ["order_id", "carrier"],
    ),
    execute: (input) => {
      const order = requireOrder(input);
      const carrier = requireStr(input, "carrier");
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.carrier = carrier;
        }
      });
      return { order_id: order.id, carrier };
    },
  }),
  createStateTransitionCapability({
    name: "mark_order_shipped",
    title: "Mark order shipped",
    description: "Mark a processing order as shipped and generate tracking.",
    domain,
    keywords: ["ship", "dispatch", "shipped"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && order.status !== "processing") {
        return unavailable(
          "INVALID_STATE",
          `Order ${order.id} is ${order.status} and cannot be marked shipped.`,
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status !== "processing") {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Order ${order.id} is ${order.status} and cannot be marked shipped.`,
          ),
        );
      }
      const tracking = `TRK-${600000 + Number(order.id)}`;
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.status = "shipped";
          target.trackingNumber = tracking;
          if (target.carrier === "unassigned") {
            target.carrier = "Northwind Express";
          }
        }
      });
      return { order_id: order.id, status: "shipped", tracking_number: tracking };
    },
  }),
  createUpdateCapability({
    name: "schedule_pickup",
    title: "Schedule carrier pickup",
    description: "Schedule a carrier pickup slot for outbound packages.",
    domain,
    keywords: ["pickup", "schedule", "collection"],
    routes: ["/shipping"],
    inputSchema: obj({ date: s("Pickup date YYYY-MM-DD") }, ["date"]),
    execute: (input) => ({
      pickup_scheduled: true,
      date: requireStr(input, "date"),
      window: "09:00-12:00",
    }),
  }),
  createStateTransitionCapability({
    name: "create_return",
    title: "Create return",
    description:
      "Open a return (RMA) for a shipped or delivered order.",
    domain,
    keywords: ["return", "rma", "send back"],
    entities: ["orderId"],
    availability: (ctx) => {
      const order = contextOrder(ctx);
      if (order && order.status !== "shipped" && order.status !== "delivered") {
        return unavailable(
          "ORDER_NOT_SHIPPED",
          "Returns only apply to shipped or delivered orders; cancel the order instead.",
          "cancel_order",
        );
      }
      return AVAILABLE;
    },
    inputSchema: obj({ order_id: s("Order id"), reason: s("Return reason") }, [
      "order_id",
      "reason",
    ]),
    execute: (input) => {
      const order = requireOrder(input);
      if (order.status !== "shipped" && order.status !== "delivered") {
        throw new CapabilityUnavailableError(
          unavailable(
            "ORDER_NOT_SHIPPED",
            "Returns only apply to shipped or delivered orders; cancel the order instead.",
            "cancel_order",
          ),
        );
      }
      const reason = requireStr(input, "reason");
      mutate((draft) => {
        const target = draft.orders.find((o) => o.id === order.id);
        if (target) {
          target.tags.push("return-open");
          target.notes.push(`Return opened: ${reason}`);
        }
      });
      return { order_id: order.id, return_opened: true, rma: `RMA-${order.id}` };
    },
  }),
];
