import type { Capability } from "@agentdesk/webmcp";
import { billingCapabilities } from "./billing.ts";
import { customerCapabilities } from "./customers.ts";
import { inventoryCapabilities } from "./inventory.ts";
import { orderCapabilities } from "./orders.ts";
import { reportCapabilities } from "./reports.ts";
import { shippingCapabilities } from "./shipping.ts";
import { supportCapabilities } from "./support.ts";

export const capabilities: Capability[] = [
  ...customerCapabilities,
  ...orderCapabilities,
  ...shippingCapabilities,
  ...billingCapabilities,
  ...inventoryCapabilities,
  ...supportCapabilities,
  ...reportCapabilities,
];

export const capabilityDomains = [
  "customers",
  "orders",
  "shipping",
  "billing",
  "inventory",
  "support",
  "reports",
] as const;
