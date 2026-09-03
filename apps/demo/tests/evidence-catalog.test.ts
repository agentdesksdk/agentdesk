import { beforeEach, describe, expect, it } from "vitest";
import { createAgentDeskRuntime, type Capability } from "@agentdesksdk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { stagingAdapter } from "../src/capabilities/staged.ts";
import { isRegisteredRevealToken } from "../src/components/reveal.ts";
import { getState, resetStore } from "../src/data/store.ts";
import type { DemoState } from "../src/data/types.ts";

const OPERATOR = { id: "operator", name: "Operator", kind: "human" as const };

/**
 * An input that lets each consequential capability run on the seed. Keyed
 * by name only so a capability can be looked up; the test itself walks the
 * catalog, so a new consequential capability with no entry here fails
 * loudly rather than slipping past unchecked.
 */
const FIXTURES: Record<string, (state: DemoState) => Record<string, unknown>> = {
  refund_shipping: () => ({ order_id: "10428" }),
  cancel_order: () => ({ order_id: "10428", reason: "Customer changed their mind." }),
  issue_credit: (state) => ({
    customer_id: state.customers[0]!.id,
    amount: 10,
    reason: "Goodwill for the late lamp.",
  }),
  refund_payment: (state) => ({
    order_id: state.invoices.find((inv) => inv.status === "paid")!.orderId,
  }),
  void_invoice: (state) => ({
    invoice_id: state.invoices.find((inv) => inv.status === "due")!.id,
  }),
  merge_customers: (state) => ({
    primary_id: state.customers[0]!.id,
    duplicate_id: state.customers[1]!.id,
  }),
  anonymize_customer: (state) => ({ customer_id: state.customers[3]!.id }),
  discontinue_product: (state) => ({
    sku: state.products.find((p) => !p.discontinued)!.sku,
  }),
};

async function runThroughApproval(capability: Capability) {
  const fixture = FIXTURES[capability.name];
  if (fixture === undefined) {
    throw new Error(
      `${capability.name} is consequential and has no input fixture; add one so its evidence is checked`,
    );
  }
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    staging: stagingAdapter,
    actor: { id: "agent", name: "Agent", kind: "agent" },
  });
  await runtime.start();
  const asked = await runtime.invoke(capability.name, fixture(getState()));
  expect(asked.code, `${capability.name}: ${asked.content[0]?.text}`).toBe("APPROVAL_REQUIRED");
  const done = await runtime.approve(runtime.getSnapshot().pending[0]!.id, OPERATOR);
  expect(done.isError, `${capability.name}: ${done.content[0]?.text}`).not.toBe(true);
  const stored = runtime.queryReceipts({ capability: capability.name });
  await runtime.stop();
  return stored;
}

describe("every consequential capability proves its write with authored evidence", () => {
  beforeEach(() => {
    resetStore();
  });

  const consequential = capabilities.filter((c) => c.risk === "CONSEQUENTIAL");

  it("is a non-trivial set", () => {
    expect(consequential.length).toBeGreaterThanOrEqual(8);
  });

  for (const capability of consequential) {
    it(`${capability.name} produces a receipt whose every link is authored and resolvable`, async () => {
      const stored = await runThroughApproval(capability);
      expect(stored, `${capability.name} produced no receipt`).toHaveLength(1);
      const receipt = stored[0]!.receipt;
      expect(receipt.changes.length, `${capability.name} recorded no changes`).toBeGreaterThan(0);
      const evidence = receipt.evidence ?? [];
      expect(evidence.length, `${capability.name} carries no evidence`).toBeGreaterThan(0);
      for (const link of evidence) {
        expect(link.source, `${capability.name}: ${link.label}`).toBe("authored");
        expect(link.label.trim().length).toBeGreaterThan(0);
        expect(link.route.startsWith("/"), `${capability.name}: route ${link.route}`).toBe(true);
        // An authored link points at the value; that needs an anchor.
        expect(link.reveal, `${capability.name}: ${link.label} has no anchor`).toBeDefined();
        expect(isRegisteredRevealToken(link.reveal!)).toBe(true);
      }
    });
  }
});
