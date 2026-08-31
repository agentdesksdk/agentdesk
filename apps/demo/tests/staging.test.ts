import { beforeEach, describe, expect, it } from "vitest";
import { createAgentDeskRuntime, type Change } from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { projectedConflicts } from "../src/capabilities/staged.ts";
import { deriveChanges } from "../src/data/branch.ts";
import { getState, mutate, resetStore } from "../src/data/store.ts";
import type { DemoState } from "../src/data/types.ts";

async function startRuntime() {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
  });
  await runtime.start();
  return runtime;
}

const snapshot = (): DemoState => structuredClone(getState());
const order = (id: string) => getState().orders.find((o) => o.id === id)!;

describe("the approval diff is derived, not declared", () => {
  beforeEach(() => {
    resetStore();
  });

  it("labels the evidence as derived and shows what the handler did", async () => {
    const runtime = await startRuntime();
    const result = await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });

    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.approvalEvidence).toBe("derived");
    expect(result.data?.will_change).toContainEqual({
      field: "Order #10428 status",
      before: "processing",
      after: "cancelled",
    });
  });

  it("stages the write without touching what the human is looking at", async () => {
    const runtime = await startRuntime();
    const before = snapshot();

    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });

    expect(getState()).toEqual(before);
    expect(order("10428").status).toBe("processing");
  });

  it("lands exactly the change the human approved", async () => {
    const runtime = await startRuntime();
    const requested = await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });
    const approved = requested.data?.will_change as Change[];

    const before = snapshot();
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(approved.length).toBeGreaterThan(0);
    expect(deriveChanges(before, getState())).toEqual(approved);
  });
});

describe("the human keeps working while an approval is pending", () => {
  beforeEach(() => {
    resetStore();
  });

  it("keeps both edits when they touch different fields", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });

    mutate((draft) => {
      const target = draft.orders.find((o) => o.id === "10428")!;
      target.carrier = "DHL";
      target.notes.push("Customer called about this.");
    });

    await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(order("10428").status).toBe("cancelled");
    expect(order("10428").carrier).toBe("DHL");
    expect(order("10428").notes).toContain("Customer called about this.");
  });

  it("refuses rather than applying half of a reviewed change", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });
    const invoiceBefore = getState().invoices.find(
      (invoice) => invoice.orderId === "10428",
    )!.status;

    mutate((draft) => {
      draft.orders.find((o) => o.id === "10428")!.status = "on_hold";
    });

    const result = await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(result.data?.reasonCode).toBe("APPROVAL_STALE");
    expect(order("10428").status).toBe("on_hold");
    expect(
      getState().invoices.find((invoice) => invoice.orderId === "10428")!.status,
    ).toBe(invoiceBefore);
  });

  it("surfaces the collision on the card before the human approves", async () => {
    const runtime = await startRuntime();
    const input = { order_id: "10428", reason: "Customer changed their mind." };
    await runtime.invoke("cancel_order", input);

    expect(projectedConflicts("cancel_order", input)).toEqual([]);

    mutate((draft) => {
      draft.orders.find((o) => o.id === "10428")!.status = "on_hold";
    });

    expect(projectedConflicts("cancel_order", input)).toEqual([
      {
        collection: "orders",
        key: "10428",
        field: "status",
        human: "on_hold",
        agent: "cancelled",
      },
    ]);
  });
});

describe("re-deriving instead of merging a stale write", () => {
  beforeEach(() => {
    resetStore();
  });

  it("refuses to land a refund whose credit id the human already took", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });

    await runtime.invoke("issue_credit", {
      customer_id: "C-1001",
      amount: 5,
      reason: "Goodwill",
    });
    await runtime.approve(runtime.getSnapshot().pending[1]!.id);

    const result = await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(result.data?.reasonCode).toBe("APPROVAL_STALE");
    expect(order("10428").shippingRefunded).toBe(false);
    expect(new Set(getState().credits.map((c) => c.id)).size).toBe(
      getState().credits.length,
    );
  });

  it("still lands when the human's edit does not change the operation", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });

    mutate((draft) => {
      draft.orders.find((o) => o.id === "10428")!.carrier = "DHL";
    });

    const result = await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(result.code).toBeUndefined();
    expect(order("10428").shippingRefunded).toBe(true);
    expect(order("10428").carrier).toBe("DHL");
  });
});

describe("staged operations inside a plan", () => {
  beforeEach(() => {
    resetStore();
  });

  it("commits a two-operation plan through the branches it previewed", async () => {
    const runtime = await startRuntime();
    const plan = await runtime.prepare({
      operations: [
        { capability: "cancel_order", input: { order_id: "10428", reason: "Duplicate." } },
        { capability: "add_order_note", input: { order_id: "10428", note: "Cancelled." } },
      ],
    });

    expect(plan.operations[0]!.preview).toContainEqual({
      field: "Order #10428 status",
      before: "processing",
      after: "cancelled",
    });
    expect(order("10428").status).toBe("processing");

    runtime.approvePlan(plan.id, { id: "operator-1", name: "Amein", kind: "human" });
    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(true);
    expect(committed.plan?.status).toBe("COMMITTED");
    expect(order("10428").status).toBe("cancelled");
    expect(order("10428").notes).toContain("Cancelled.");
  });
});
