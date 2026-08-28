import type { Capability } from "@agentdesk/webmcp";
import { getState } from "../data/store.ts";
import { orderTotal, round2 } from "../data/types.ts";
import { createReportCapability } from "./factories.ts";
import { obj, s, str } from "./helpers.ts";

export const reportCapabilities: Capability[] = [
  createReportCapability({
    name: "get_revenue_summary",
    title: "Revenue summary",
    description: "Revenue from non-cancelled orders, split by order status.",
    intents: ["revenue", "sales summary", "how much revenue"],
    keywords: ["revenue", "sales", "income"],
    routes: ["/reports", "/"],
    inputSchema: obj({}),
    execute: () => {
      const orders = getState().orders.filter((o) => o.status !== "cancelled");
      const byStatus = new Map<string, number>();
      for (const order of orders) {
        byStatus.set(
          order.status,
          round2((byStatus.get(order.status) ?? 0) + orderTotal(order)),
        );
      }
      const total = round2(orders.reduce((sum, o) => sum + orderTotal(o), 0));
      return {
        total_revenue: total,
        orders: orders.length,
        by_status: Object.fromEntries(byStatus),
      };
    },
  }),
  createReportCapability({
    name: "generate_order_report",
    title: "Order report",
    description: "Order counts and value grouped by status, optionally for one month (YYYY-MM).",
    intents: ["order report"],
    keywords: ["report", "order", "count"],
    routes: ["/reports"],
    inputSchema: obj({ month: s("Optional month filter, YYYY-MM") }),
    execute: (input) => {
      const month = str(input, "month");
      const orders = getState().orders.filter((o) =>
        month ? o.placedAt.startsWith(month) : true,
      );
      const byStatus: Record<string, { count: number; value: number }> = {};
      for (const order of orders) {
        const bucket = (byStatus[order.status] ??= { count: 0, value: 0 });
        bucket.count += 1;
        bucket.value = round2(bucket.value + orderTotal(order));
      }
      return { month: month ?? "all", orders: orders.length, by_status: byStatus };
    },
  }),
  createReportCapability({
    name: "get_refund_report",
    title: "Refund report",
    description: "All credits and shipping refunds issued, with totals.",
    intents: ["refund report", "refunds issued"],
    keywords: ["refund", "credit", "report"],
    routes: ["/reports", "/billing"],
    inputSchema: obj({}),
    execute: () => {
      const credits = getState().credits;
      const refundedShipping = getState().orders.filter((o) => o.shippingRefunded);
      return {
        credits_issued: credits.length,
        credits_total: round2(credits.reduce((sum, c) => sum + c.amount, 0)),
        shipping_refunds: refundedShipping.map((o) => ({
          order_id: o.id,
          amount: o.shippingFee,
        })),
      };
    },
  }),
  createReportCapability({
    name: "get_customer_growth",
    title: "Customer growth",
    description: "New customers per month since tracking began.",
    keywords: ["growth", "customer", "signup"],
    routes: ["/reports"],
    inputSchema: obj({}),
    execute: () => {
      const byMonth = new Map<string, number>();
      for (const customer of getState().customers) {
        const month = customer.createdAt.slice(0, 7);
        byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
      }
      return {
        months: [...byMonth.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([month, count]) => ({ month, new_customers: count })),
      };
    },
  }),
  createReportCapability({
    name: "get_fulfillment_metrics",
    title: "Fulfillment metrics",
    description: "Share of orders shipped, delivered, processing, and on hold.",
    keywords: ["fulfillment", "shipped", "metric"],
    routes: ["/reports", "/shipping"],
    inputSchema: obj({}),
    execute: () => {
      const orders = getState().orders;
      const count = (status: string) =>
        orders.filter((o) => o.status === status).length;
      return {
        total_orders: orders.length,
        processing: count("processing"),
        on_hold: count("on_hold"),
        shipped: count("shipped"),
        delivered: count("delivered"),
        cancelled: count("cancelled"),
      };
    },
  }),
  createReportCapability({
    name: "get_inventory_valuation",
    title: "Inventory valuation",
    description: "Total value of stock on hand at list price.",
    keywords: ["valuation", "inventory", "worth"],
    routes: ["/reports", "/inventory"],
    inputSchema: obj({}),
    execute: () => {
      const products = getState().products.filter((p) => !p.discontinued);
      return {
        skus: products.length,
        units: products.reduce((sum, p) => sum + p.stock, 0),
        valuation: round2(
          products.reduce((sum, p) => sum + p.stock * p.price, 0),
        ),
      };
    },
  }),
  createReportCapability({
    name: "get_top_products",
    title: "Top products",
    description: "Products ranked by units sold across all orders.",
    intents: ["best sellers", "top products"],
    keywords: ["top", "best", "product", "seller"],
    routes: ["/reports"],
    inputSchema: obj({}),
    execute: () => {
      const units = new Map<string, { name: string; units: number }>();
      for (const order of getState().orders) {
        if (order.status === "cancelled") {
          continue;
        }
        for (const item of order.items) {
          const entry = units.get(item.sku) ?? { name: item.name, units: 0 };
          entry.units += item.quantity;
          units.set(item.sku, entry);
        }
      }
      return {
        products: [...units.entries()]
          .map(([sku, entry]) => ({ sku, ...entry }))
          .sort((a, b) => b.units - a.units)
          .slice(0, 8),
      };
    },
  }),
  createReportCapability({
    name: "get_shipping_cost_report",
    title: "Shipping cost report",
    description: "Shipping fees charged, waived, and refunded across orders.",
    keywords: ["shipping", "cost", "fee", "report"],
    routes: ["/reports", "/shipping"],
    inputSchema: obj({}),
    execute: () => {
      const orders = getState().orders.filter((o) => o.status !== "cancelled");
      const charged = orders.filter((o) => o.shippingPaid);
      const refunded = orders.filter((o) => o.shippingRefunded);
      return {
        orders_with_paid_shipping: charged.length,
        shipping_charged: round2(
          charged.reduce((sum, o) => sum + o.shippingFee, 0),
        ),
        shipping_refunded: round2(
          refunded.reduce((sum, o) => sum + o.shippingFee, 0),
        ),
        free_shipping_orders: orders.length - charged.length,
      };
    },
  }),
  createReportCapability({
    name: "get_support_metrics",
    title: "Support metrics",
    description: "Ticket volume by status and priority.",
    keywords: ["support", "ticket", "metric"],
    routes: ["/reports", "/support"],
    inputSchema: obj({}),
    execute: () => {
      const tickets = getState().tickets;
      const by = (key: "status" | "priority") => {
        const map = new Map<string, number>();
        for (const ticket of tickets) {
          map.set(ticket[key], (map.get(ticket[key]) ?? 0) + 1);
        }
        return Object.fromEntries(map);
      };
      return { total: tickets.length, by_status: by("status"), by_priority: by("priority") };
    },
  }),
  createReportCapability({
    name: "export_dashboard_snapshot",
    title: "Export dashboard snapshot",
    description: "One JSON snapshot of the headline numbers on the overview dashboard.",
    keywords: ["export", "snapshot", "dashboard"],
    routes: ["/reports", "/"],
    inputSchema: obj({}),
    execute: () => {
      const state = getState();
      const orders = state.orders.filter((o) => o.status !== "cancelled");
      return {
        customers: state.customers.length,
        orders: orders.length,
        revenue: round2(orders.reduce((sum, o) => sum + orderTotal(o), 0)),
        open_tickets: state.tickets.filter((t) => t.status !== "closed").length,
        low_stock_skus: state.products.filter(
          (p) => !p.discontinued && p.stock - p.reserved <= p.reorderPoint,
        ).length,
      };
    },
  }),
];
