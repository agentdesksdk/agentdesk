import {
  CapabilityUnavailableError,
  unavailable,
  type Capability,
  receipt,
} from "@agentdesksdk/webmcp";
import { getState, mutate } from "../data/store.ts";
import {
  createReadCapability,
  createSearchCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import { n, num, obj, requireProduct, requireStr, s } from "./helpers.ts";

const domain = "inventory";

export const inventoryCapabilities: Capability[] = [
  createReadCapability({
    name: "get_inventory",
    title: "Get inventory",
    description: "Stock, reserved units, and reorder point for one product.",
    domain,
    intents: ["stock level", "in stock", "inventory level"],
    keywords: ["stock", "inventory", "sku"],
    entities: ["sku"],
    routes: ["/inventory"],
    inputSchema: obj({ sku: s("Product SKU like MER-DSK-01") }, ["sku"]),
    execute: (input) => {
      const product = requireProduct(input);
      return {
        sku: product.sku,
        name: product.name,
        stock: product.stock,
        reserved: product.reserved,
        sellable: product.stock - product.reserved,
        reorder_point: product.reorderPoint,
        discontinued: product.discontinued,
      };
    },
  }),
  createSearchCapability({
    name: "search_products",
    title: "Search products",
    description: "Search the product catalog by name, SKU, or category.",
    domain,
    intents: ["find product", "search product"],
    keywords: ["product", "catalog", "sku"],
    routes: ["/inventory"],
    inputSchema: obj({ query: s("Name, SKU, or category fragment") }, ["query"]),
    execute: (input) => {
      const query = requireStr(input, "query").toLowerCase();
      const products = getState().products.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.sku.toLowerCase().includes(query) ||
          p.category.toLowerCase().includes(query),
      );
      return { count: products.length, products };
    },
  }),
  createReadCapability({
    name: "get_product",
    title: "Get product",
    description: "Full product record including price and category.",
    domain,
    keywords: ["product", "price", "detail"],
    entities: ["sku"],
    inputSchema: obj({ sku: s("Product SKU") }, ["sku"]),
    execute: (input) => requireProduct(input),
  }),
  createReadCapability({
    name: "list_low_stock",
    title: "List low stock",
    description: "Products at or below their reorder point.",
    domain,
    intents: ["low stock", "running out"],
    keywords: ["low", "reorder", "stock"],
    routes: ["/inventory"],
    inputSchema: obj({}),
    execute: () => {
      const products = getState().products.filter(
        (p) => !p.discontinued && p.stock - p.reserved <= p.reorderPoint,
      );
      return { count: products.length, products };
    },
  }),
  createReadCapability({
    name: "get_warehouse_levels",
    title: "Get warehouse levels",
    description: "Aggregate stock by product category.",
    domain,
    keywords: ["warehouse", "aggregate", "category"],
    routes: ["/inventory"],
    inputSchema: obj({}),
    execute: () => {
      const byCategory = new Map<string, number>();
      for (const product of getState().products) {
        byCategory.set(
          product.category,
          (byCategory.get(product.category) ?? 0) + product.stock,
        );
      }
      return {
        categories: [...byCategory.entries()].map(([category, units]) => ({
          category,
          units,
        })),
      };
    },
  }),
  createUpdateCapability({
    name: "adjust_stock",
    title: "Adjust stock",
    description: "Apply a positive or negative stock adjustment after a count.",
    domain,
    keywords: ["adjust", "correct", "stock"],
    entities: ["sku"],
    inputSchema: obj(
      { sku: s("Product SKU"), delta: n("Adjustment, e.g. -3 or 10") },
      ["sku", "delta"],
    ),
    execute: (input) => {
      const product = requireProduct(input);
      const delta = num(input, "delta");
      if (delta === undefined || delta === 0 || !Number.isInteger(delta)) {
        throw new Error("delta must be a non-zero whole number of units");
      }
      if (product.stock + delta < 0) {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Adjustment would make ${product.sku} stock negative.`,
          ),
        );
      }
      mutate((draft) => {
        const target = draft.products.find((p) => p.sku === product.sku);
        if (target) {
          target.stock += delta;
        }
      });
      return { sku: product.sku, stock: product.stock + delta };
    },
  }),
  createUpdateCapability({
    name: "reserve_inventory",
    title: "Reserve inventory",
    description: "Reserve sellable units of a product for an order.",
    domain,
    keywords: ["reserve", "allocate", "hold"],
    entities: ["sku"],
    inputSchema: obj(
      { sku: s("Product SKU"), quantity: n("Units to reserve") },
      ["sku", "quantity"],
    ),
    execute: (input) => {
      const product = requireProduct(input);
      const quantity = num(input, "quantity");
      if (quantity === undefined || quantity <= 0 || !Number.isInteger(quantity)) {
        throw new Error("quantity must be a positive whole number of units");
      }
      if (product.stock - product.reserved < quantity) {
        throw new CapabilityUnavailableError(
          unavailable(
            "INSUFFICIENT_STOCK",
            `Only ${product.stock - product.reserved} sellable units of ${product.sku} remain.`,
            "create_restock_order",
          ),
        );
      }
      mutate((draft) => {
        const target = draft.products.find((p) => p.sku === product.sku);
        if (target) {
          target.reserved += quantity;
        }
      });
      return { sku: product.sku, reserved: product.reserved + quantity };
    },
  }),
  createUpdateCapability({
    name: "release_inventory",
    title: "Release inventory",
    description: "Release previously reserved units back to sellable stock.",
    domain,
    keywords: ["release", "unreserve", "free"],
    entities: ["sku"],
    inputSchema: obj(
      { sku: s("Product SKU"), quantity: n("Units to release") },
      ["sku", "quantity"],
    ),
    execute: (input) => {
      const product = requireProduct(input);
      const quantity = num(input, "quantity");
      if (quantity === undefined || quantity <= 0 || !Number.isInteger(quantity)) {
        throw new Error("quantity must be a positive whole number of units");
      }
      const released = Math.min(quantity, product.reserved);
      mutate((draft) => {
        const target = draft.products.find((p) => p.sku === product.sku);
        if (target) {
          target.reserved -= released;
        }
      });
      return { sku: product.sku, released, reserved: product.reserved - released };
    },
  }),
  createUpdateCapability({
    name: "update_price",
    title: "Update price",
    description: "Set a new list price for a product.",
    domain,
    keywords: ["price", "reprice", "cost"],
    entities: ["sku"],
    inputSchema: obj(
      { sku: s("Product SKU"), price: n("New price in dollars") },
      ["sku", "price"],
    ),
    execute: (input) => {
      const product = requireProduct(input);
      const price = num(input, "price");
      if (price === undefined || price <= 0) {
        throw new Error("price must be a positive number");
      }
      mutate((draft) => {
        const target = draft.products.find((p) => p.sku === product.sku);
        if (target) {
          target.price = price;
        }
      });
      return { sku: product.sku, price };
    },
  }),
  createUpdateCapability({
    name: "create_restock_order",
    title: "Create restock order",
    description: "Raise a purchase order to restock a product.",
    domain,
    keywords: ["restock", "purchase", "replenish"],
    entities: ["sku"],
    inputSchema: obj(
      { sku: s("Product SKU"), quantity: n("Units to order") },
      ["sku", "quantity"],
    ),
    execute: (input) => {
      const product = requireProduct(input);
      const quantity = num(input, "quantity");
      if (quantity === undefined || quantity <= 0 || !Number.isInteger(quantity)) {
        throw new Error("quantity must be a positive whole number of units");
      }
      return {
        purchase_order: `PO-${product.sku}-${quantity}`,
        sku: product.sku,
        quantity,
        eta_days: 14,
      };
    },
  }),
  createStateTransitionCapability({
    name: "discontinue_product",
    title: "Discontinue product",
    description:
      "Permanently discontinue a product so it can no longer be sold. Requires human approval.",
    domain,
    consequential: true,
    keywords: ["discontinue", "retire", "remove", "product"],
    entities: ["sku"],
    inputSchema: obj({ sku: s("Product SKU") }, ["sku"]),
    describeApproval: (input) =>
      `Discontinue product ${String(input.sku)}. It is removed from sale permanently.`,
    execute: (input) => {
      const product = requireProduct(input);
      if (product.discontinued) {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", `${product.sku} is already discontinued.`),
        );
      }
      mutate((draft) => {
        const target = draft.products.find((p) => p.sku === product.sku);
        if (target) {
          target.discontinued = true;
        }
      });
      return receipt({
        entity: `Product ${product.sku}`,
        changes: [{ field: `${product.name} discontinued`, before: false, after: true }],
        evidence: [
          {
            label: `${product.name} (${product.sku}) in the inventory list`,
            route: "/inventory",
            reveal: "inventory-table",
          },
        ],
        result: { sku: product.sku, discontinued: true },
      });
    },
  }),
];
