import {
  CapabilityUnavailableError,
  unavailable,
  type InputSchema,
} from "@agentdesksdk/webmcp";
import { getState } from "../data/store.ts";
import type { Customer, Order, Product, Ticket } from "../data/types.ts";
import { orderTotal } from "../data/types.ts";

export function obj(
  properties: Record<string, Record<string, unknown>>,
  required?: string[],
): InputSchema {
  // JSON Schema `required` only checks presence, so a required string
  // needs minLength to reject "" before it reaches a handler guard.
  for (const key of required ?? []) {
    const property = properties[key];
    if (property?.type === "string" && property.minLength === undefined) {
      property.minLength = 1;
    }
  }
  const schema: InputSchema = { type: "object", properties };
  if (required && required.length > 0) {
    schema.required = required;
  }
  return schema;
}

export const s = (description: string) => ({ type: "string", description });
export const n = (description: string) => ({ type: "number", description });

export function str(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function num(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function requireStr(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function findOrder(id: string): Order | undefined {
  return getState().orders.find((order) => order.id === id.replace(/^#/, ""));
}

export function requireOrder(
  input: Record<string, unknown>,
  key = "order_id",
): Order {
  const id = requireStr(input, key);
  const order = findOrder(id);
  if (!order) {
    throw new CapabilityUnavailableError(
      unavailable("MISSING_ORDER", `No order ${id} exists.`, "search_orders"),
    );
  }
  return order;
}

export function requireCustomer(
  input: Record<string, unknown>,
  key = "customer_id",
): Customer {
  const id = requireStr(input, key);
  const state = getState();
  const customer =
    state.customers.find((c) => c.id === id) ??
    state.customers.find((c) => c.name.toLowerCase() === id.toLowerCase());
  if (!customer) {
    throw new CapabilityUnavailableError(
      unavailable(
        "MISSING_CUSTOMER",
        `No customer ${id} exists.`,
        "search_customers",
      ),
    );
  }
  return customer;
}

export function requireProduct(
  input: Record<string, unknown>,
  key = "sku",
): Product {
  const sku = requireStr(input, key);
  const product = getState().products.find(
    (p) => p.sku.toLowerCase() === sku.toLowerCase(),
  );
  if (!product) {
    throw new CapabilityUnavailableError(
      unavailable("MISSING_PRODUCT", `No product ${sku} exists.`, "search_products"),
    );
  }
  return product;
}

export function requireTicket(
  input: Record<string, unknown>,
  key = "ticket_id",
): Ticket {
  const id = requireStr(input, key);
  const ticket = getState().tickets.find((t) => t.id === id);
  if (!ticket) {
    throw new CapabilityUnavailableError(
      unavailable("MISSING_TICKET", `No ticket ${id} exists.`, "search_tickets"),
    );
  }
  return ticket;
}

export function customerSummary(customer: Customer) {
  return {
    customer_id: customer.id,
    name: customer.name,
    email: customer.email,
    city: customer.city,
    country: customer.country,
    segment: customer.segment,
    tags: customer.tags,
  };
}

export function orderSummary(order: Order) {
  const customer = getState().customers.find((c) => c.id === order.customerId);
  return {
    order_id: order.id,
    customer_id: order.customerId,
    customer_name: customer?.name ?? "unknown",
    status: order.status,
    placed_at: order.placedAt,
    total: orderTotal(order),
    shipping_fee: order.shippingFee,
    shipping_paid: order.shippingPaid,
    shipping_refunded: order.shippingRefunded,
    item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Resolves an order_id input to its detail route for guided presentation. */
export function orderRoute(
  input: Record<string, unknown>,
): string | undefined {
  const id = str(input, "order_id");
  return id === undefined ? undefined : `/orders/${id.replace(/^#/, "")}`;
}

export function customerRoute(
  input: Record<string, unknown>,
  key = "customer_id",
): string | undefined {
  const raw = str(input, key);
  if (raw === undefined) {
    return undefined;
  }
  const customer = getState().customers.find(
    (c) => c.id === raw || c.name.toLowerCase() === raw.toLowerCase(),
  );
  return customer ? `/customers/${customer.id}` : undefined;
}
