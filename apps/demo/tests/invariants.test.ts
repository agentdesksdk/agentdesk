import { beforeEach, describe, expect, it } from "vitest";
import { createAgentDeskRuntime } from "@agentdesksdk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { stagingAdapter } from "../src/capabilities/staged.ts";
import { getState, resetStore } from "../src/data/store.ts";

async function startRuntime() {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    staging: stagingAdapter,
  });
  await runtime.start();
  return runtime;
}

async function approveFirst(runtime: Awaited<ReturnType<typeof startRuntime>>) {
  const actionId = runtime.getSnapshot().pending[0]!.id;
  return runtime.approve(actionId, { id: "operator", name: "Operator", kind: "human" });
}

describe("financial invariants", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shipping refund followed by full refund never exceeds collected funds", async () => {
    const runtime = await startRuntime();
    const order = getState().orders.find((o) => o.id === "10428")!;
    const invoice = getState().invoices.find((inv) => inv.orderId === "10428")!;
    // Collect the due hero invoice first so a payment refund is legitimate.
    await runtime.invoke("retry_payment", { invoice_id: invoice.id });

    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await approveFirst(runtime);
    expect(getState().orders.find((o) => o.id === "10428")!.shippingRefunded).toBe(true);

    await runtime.invoke("refund_payment", { order_id: "10428" });
    await approveFirst(runtime);

    const credited = getState()
      .credits.filter((c) => c.customerId === order.customerId)
      .reduce((sum, c) => sum + c.amount, 0);
    expect(credited).toBeCloseTo(invoice.total, 2);
  });

  it("refund_payment rejects an uncollected (due) invoice before approval", async () => {
    const runtime = await startRuntime();
    const result = await runtime.invoke("refund_payment", { order_id: "10428" });
    expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(result.data?.reasonCode).toBe("PAYMENT_NOT_COLLECTED");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });

  it("issue_credit with malformed input never reaches the approval queue", async () => {
    const runtime = await startRuntime();
    const result = await runtime.invoke("issue_credit", {});
    expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(result.data?.reasonCode).toBe("INVALID_INPUT");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });
});

describe("relational invariants", () => {
  beforeEach(() => {
    resetStore();
  });

  it("self-merge is rejected before approval and leaves all references intact", async () => {
    const runtime = await startRuntime();
    const before = getState().customers.length;
    const result = await runtime.invoke("merge_customers", {
      primary_id: "C-1001",
      duplicate_id: "C-1001",
    });
    expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(result.data?.reasonCode).toBe("INVALID_INPUT");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
    expect(getState().customers.length).toBe(before);
    for (const order of getState().orders) {
      expect(
        getState().customers.some((c) => c.id === order.customerId),
      ).toBe(true);
    }
  });

  it("fractional inventory adjustments are rejected", async () => {
    const runtime = await startRuntime();
    const result = await runtime.invoke("adjust_stock", {
      sku: "MER-DSK-01",
      delta: 0.5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("whole number");
  });
});
