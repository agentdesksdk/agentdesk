import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  type AgentDeskRuntime,
  type Capability,
  type ToolResult,
} from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { getState, resetStore } from "../src/data/store.ts";

type ExerciseCase = {
  input: Record<string, unknown>;
  /** Moves the store into the state the handler's happy path needs. */
  setup?: (runtime: AgentDeskRuntime) => Promise<void>;
};

const CASES: Record<string, ExerciseCase> = {
  search_customers: { input: { query: "Alice" } },
  get_customer: { input: { customer_id: "C-1001" } },
  list_customer_orders: { input: { customer_id: "C-1001", status: "processing" } },
  list_customer_addresses: { input: { customer_id: "C-1001" } },
  get_customer_lifetime_value: { input: { customer_id: "C-1001" } },
  add_customer_note: {
    input: { customer_id: "C-1001", note: "Called about packaging." },
  },
  tag_customer: { input: { customer_id: "C-1001", tag: "wholesale" } },
  update_customer_email: {
    input: { customer_id: "C-1001", email: "alice.j@example.com" },
  },
  update_customer_phone: { input: { customer_id: "C-1001", phone: "+1 555 0199" } },
  merge_customers: { input: { primary_id: "C-1001", duplicate_id: "C-1002" } },
  anonymize_customer: { input: { customer_id: "C-1002" } },

  search_orders: { input: { query: "10428" } },
  inspect_order: { input: { order_id: "10428" } },
  get_order_items: { input: { order_id: "10428" } },
  get_order_totals: { input: { order_id: "10428" } },
  get_order_timeline: { input: { order_id: "10428" } },
  find_unshipped_orders: { input: { customer: "Alice Johnson" } },
  list_recent_orders: { input: { limit: 5 } },
  add_order_note: { input: { order_id: "10428", note: "Pack with extra foam." } },
  tag_order: { input: { order_id: "10428", tag: "fragile" } },
  hold_order: { input: { order_id: "10428", reason: "Address needs confirming." } },
  release_order_hold: {
    input: { order_id: "10428" },
    setup: async (runtime) => {
      await runtime.invoke("hold_order", {
        order_id: "10428",
        reason: "Address needs confirming.",
      });
    },
  },
  cancel_order: { input: { order_id: "10428", reason: "Customer changed mind." } },
  duplicate_order: { input: { order_id: "10428" } },

  get_order_shipping: { input: { order_id: "10428" } },
  refund_shipping: { input: { order_id: "10428" } },
  get_shipping_rates: { input: {} },
  estimate_delivery: { input: { order_id: "10428" } },
  track_shipment: { input: { order_id: "10423" } },
  list_pending_shipments: { input: {} },
  update_shipping_address: {
    input: { order_id: "10428", address: "Seattle, US" },
  },
  assign_carrier: { input: { order_id: "10428", carrier: "Atlas Post" } },
  mark_order_shipped: { input: { order_id: "10428" } },
  schedule_pickup: { input: { date: "2026-09-01" } },
  create_return: { input: { order_id: "10423", reason: "Arrived scratched." } },

  get_invoice: { input: { invoice_id: "INV-3021" } },
  list_invoices: { input: { status: "due" } },
  list_customer_invoices: { input: { customer_id: "C-1001" } },
  get_payment_status: { input: { order_id: "10428" } },
  get_billing_summary: { input: {} },
  list_credits: { input: {} },
  issue_credit: {
    input: { customer_id: "C-1001", amount: 25, reason: "Goodwill for delay." },
  },
  refund_payment: { input: { order_id: "10423" } },
  void_invoice: { input: { invoice_id: "INV-3021" } },
  apply_discount: { input: { invoice_id: "INV-3021", percent: 10 } },
  retry_payment: { input: { invoice_id: "INV-3021" } },
  get_tax_summary: { input: {} },

  get_inventory: { input: { sku: "MER-DSK-01" } },
  search_products: { input: { query: "desk" } },
  get_product: { input: { sku: "MER-DSK-01" } },
  list_low_stock: { input: {} },
  get_warehouse_levels: { input: {} },
  adjust_stock: { input: { sku: "MER-DSK-01", delta: 5 } },
  reserve_inventory: { input: { sku: "MER-DSK-01", quantity: 2 } },
  release_inventory: { input: { sku: "MER-DSK-01", quantity: 1 } },
  update_price: { input: { sku: "MER-DSK-01", price: 699 } },
  create_restock_order: { input: { sku: "MER-DSK-01", quantity: 20 } },
  discontinue_product: { input: { sku: "MER-DSK-01" } },

  list_open_tickets: { input: {} },
  get_ticket: { input: { ticket_id: "T-2001" } },
  search_tickets: { input: { query: "invoice" } },
  list_customer_tickets: { input: { customer_id: "C-1002" } },
  create_ticket: {
    input: { customer_id: "C-1001", subject: "Desk arrived late", priority: "high" },
  },
  reply_to_ticket: {
    input: { ticket_id: "T-2001", message: "We are shipping a replacement." },
  },
  create_support_note: {
    input: { ticket_id: "T-2001", note: "Warehouse confirmed the mispick." },
  },
  escalate_ticket: { input: { ticket_id: "T-2001" } },
  close_ticket: { input: { ticket_id: "T-2001" } },
  reopen_ticket: { input: { ticket_id: "T-2005" } },

  get_revenue_summary: { input: {} },
  generate_order_report: { input: { month: "2026-08" } },
  get_refund_report: { input: {} },
  get_customer_growth: { input: {} },
  get_fulfillment_metrics: { input: {} },
  get_inventory_valuation: { input: {} },
  get_top_products: { input: {} },
  get_shipping_cost_report: { input: {} },
  get_support_metrics: { input: {} },
  export_dashboard_snapshot: { input: {} },
};

const STRUCTURED_CODES = new Set([
  "CAPABILITY_UNAVAILABLE",
  "VALIDATION_FAILED",
  "POLICY_DENIED",
]);

function describeResult(result: ToolResult): string {
  const code = result.code ?? "no code";
  return `${code}: ${result.content[0]?.text ?? "<empty>"}`;
}

/** Returns a failure description, or null when the outcome is structured. */
function classify(result: ToolResult): string | null {
  lastOutcomeWasSuccess = result.isError !== true;
  if (result.isError !== true) {
    return null;
  }
  if (result.code !== undefined && STRUCTURED_CODES.has(result.code)) {
    return null;
  }
  return `unstructured error -> ${describeResult(result)}`;
}

async function exercise(
  runtime: AgentDeskRuntime,
  capability: Capability,
  input: Record<string, unknown>,
): Promise<string | null> {
  lastOutcomeWasSuccess = false;
  let result: ToolResult;
  try {
    result = await runtime.invoke(capability.name, input);
  } catch (err) {
    return `threw ${err instanceof Error ? err.message : String(err)}`;
  }

  if (capability.risk !== "CONSEQUENTIAL") {
    return classify(result);
  }

  if (result.code !== "APPROVAL_REQUIRED") {
    return `expected APPROVAL_REQUIRED, got ${describeResult(result)}`;
  }
  const approvalId = result.data?.approval_id;
  if (typeof approvalId !== "string") {
    return "APPROVAL_REQUIRED carried no approval_id";
  }
  try {
    return classify(await runtime.approve(approvalId));
  } catch (err) {
    return `approve threw ${err instanceof Error ? err.message : String(err)}`;
  }
}

const exercised = new Set<string>();
const failures: string[] = [];
const reachedHappyPath = new Set<string>();
let lastOutcomeWasSuccess = false;

describe("capability execution", () => {
  beforeEach(() => {
    resetStore();
  });

  it("seeds the fixtures every sample input depends on", () => {
    const state = getState();
    expect(state.customers.find((c) => c.id === "C-1001")?.name).toBe(
      "Alice Johnson",
    );
    expect(state.customers.find((c) => c.id === "C-1002")).toBeDefined();
    expect(state.orders.find((o) => o.id === "10428")?.status).toBe("processing");
    expect(state.orders.find((o) => o.id === "10423")).toMatchObject({
      status: "delivered",
    });
    expect(state.orders.find((o) => o.id === "10423")?.trackingNumber).not.toBeNull();
    expect(state.invoices.find((i) => i.id === "INV-3021")).toMatchObject({
      orderId: "10428",
      status: "due",
    });
    expect(state.invoices.find((i) => i.orderId === "10423")?.status).toBe("paid");
    expect(state.tickets.find((t) => t.id === "T-2001")?.status).toBe("open");
    expect(state.tickets.find((t) => t.id === "T-2005")?.status).toBe("closed");
    expect(state.products.find((p) => p.sku === "MER-DSK-01")?.discontinued).toBe(
      false,
    );
  });

  for (const capability of capabilities) {
    it(`${capability.name} runs and returns a structured outcome`, async () => {
      const testCase = CASES[capability.name];
      expect(testCase, `no sample input defined for ${capability.name}`).toBeDefined();

      const runtime = createAgentDeskRuntime({
        capabilities,
        registerTool: async () => {},
        exposure: "flat",
      });
      await runtime.start();
      await testCase!.setup?.(runtime);

      const failure = await exercise(runtime, capability, testCase!.input);
      exercised.add(capability.name);
      if (failure !== null) {
        failures.push(`${capability.name}: ${failure}`);
      } else if (lastOutcomeWasSuccess) {
        reachedHappyPath.add(capability.name);
      }
      expect(failure, `${capability.name} failed unstructured`).toBeNull();
    });
  }

  it("exercised every capability with no unstructured errors", () => {
    expect(failures).toEqual([]);
    expect(exercised.size).toBe(capabilities.length);
  });

  // Accepting a blocked-but-structured outcome is what keeps this suite
  // from going vacuous: every case could pass while no handler body ever
  // ran. Assert the happy path was actually reached instead.
  it("every capability reached its handler, not just a guard", () => {
    const blocked = capabilities
      .map((capability) => capability.name)
      .filter((name) => !reachedHappyPath.has(name));
    expect(blocked).toEqual([]);
  });
});
