import { beforeEach, describe, expect, it } from "vitest";
import { createAgentDeskRuntime } from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import {
  getState,
  mutate,
  resetStore,
  stagingScope,
} from "../src/data/store.ts";

function revision(): string {
  const state = getState();
  return [
    state.orders.map((o) => `${o.id}:${o.status}:${o.shippingRefunded}`).join("|"),
    state.credits.length,
    state.invoices.map((i) => `${i.id}:${i.status}`).join("|"),
  ].join("#");
}

const OPERATOR = { id: "operator", name: "Operator", kind: "human" as const };

async function startRuntime() {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    revision,
    stagingScope,
    actor: { id: "agent", name: "Agent", kind: "agent" },
  });
  await runtime.start();
  return runtime;
}

async function refundHeroOrder(
  runtime: Awaited<ReturnType<typeof startRuntime>>,
) {
  await runtime.invoke("refund_shipping", { order_id: "10428" });
  await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });
}

describe("demo verification and rollback", () => {
  beforeEach(() => {
    resetStore();
  });

  it("verifies the refund by reading the order back", async () => {
    const runtime = await startRuntime();
    await refundHeroOrder(runtime);

    const stored = runtime.queryReceipts({ capability: "refund_shipping" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.verification.status).toBe("VERIFIED");
    expect(stored[0]?.executedBy?.id).toBe("agent");
  });

  it("rolling back restores the order, the invoice, and the credit ledger", async () => {
    const runtime = await startRuntime();
    const invoiceBefore = getState().invoices.find((i) => i.orderId === "10428")!;
    const creditsBefore = getState().credits.length;

    await refundHeroOrder(runtime);
    expect(getState().credits).toHaveLength(creditsBefore + 1);

    const stored = runtime.queryReceipts({ capability: "refund_shipping" })[0]!;
    const undone = await runtime.rollback(stored.id);

    expect(undone.ok).toBe(true);
    expect(getState().orders.find((o) => o.id === "10428")!.shippingRefunded).toBe(
      false,
    );
    expect(getState().invoices.find((i) => i.orderId === "10428")!.status).toBe(
      invoiceBefore.status,
    );
    expect(getState().credits).toHaveLength(creditsBefore);
  });

  it("refuses to roll back once the credit the receipt named is gone", async () => {
    const runtime = await startRuntime();
    await refundHeroOrder(runtime);
    const stored = runtime.queryReceipts({ capability: "refund_shipping" })[0]!;

    // The order still reads as refunded, so the SDK verifier is satisfied.
    // Only the demo's own guard can catch that the credit moved.
    mutate((draft) => {
      draft.credits = [];
    });

    const undone = await runtime.rollback(stored.id);
    expect(undone.ok).toBe(false);
    if (!undone.ok) {
      expect(undone.reason).toMatch(/Credit CR-\d+ is already gone/);
    }
    expect(
      getState().invoices.find((i) => i.orderId === "10428")!.status,
    ).toBe("partially_refunded");
  });

  it("refuses to commit a plan prepared against stale application state", async () => {
    const runtime = await startRuntime();
    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping", input: { order_id: "10428" } },
      ],
    });
    expect(runtime.approvePlan(plan.id, OPERATOR).ok).toBe(true);

    // Someone else refunds the same order between review and commit.
    await refundHeroOrder(runtime);

    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok).toBe(false);
    expect(runtime.getPlan(plan.id)?.status).toBe("DRIFTED");
    expect(getState().credits.filter((c) => c.reason.includes("10428"))).toHaveLength(
      1,
    );
  });

  it("commits an approved plan across two domains and records provenance", async () => {
    const runtime = await startRuntime();
    const plan = await runtime.prepare({
      operations: [
        { capability: "refund_shipping", input: { order_id: "10428" } },
        {
          capability: "add_order_note",
          input: { order_id: "10428", note: "Shipping refunded per policy." },
        },
      ],
    });
    expect(plan.risk).toBe("CONSEQUENTIAL");
    expect(plan.operations[0]?.preview.length).toBeGreaterThan(0);

    runtime.approvePlan(plan.id, OPERATOR);
    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(true);
    const settled = runtime.getPlan(plan.id)!;
    expect(settled.status).toBe("COMMITTED");
    expect(settled.outcomes?.map((o) => o.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(settled.outcomes?.[0]?.verification.status).toBe("VERIFIED");

    // Only the refund returns a receipt envelope, so only it lands in history.
    const recorded = runtime.queryReceipts({ planId: plan.id });
    expect(recorded.map((r) => r.capability)).toEqual(["refund_shipping"]);
  });
});
