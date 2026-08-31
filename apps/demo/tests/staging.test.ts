import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  type Change,
} from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import { createStateTransitionCapability } from "../src/capabilities/factories.ts";
import {
  openProposalCount,
  stagedChangesFor,
} from "../src/capabilities/staged.ts";
import { deriveChanges } from "../src/data/branch.ts";
import {
  getState,
  mutate,
  resetStore,
  stage,
  stagingScope,
} from "../src/data/store.ts";
import type { DemoState } from "../src/data/types.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

async function startRuntime(extra: Parameters<typeof defineCapability>[0][] = []) {
  const runtime = createAgentDeskRuntime({
    capabilities: [...capabilities, ...extra.map(defineCapability)],
    registerTool: async () => {},
    actor: { id: "agent", name: "Agent", kind: "agent" },
    stagingScope,
  });
  await runtime.start();
  return runtime;
}

const snapshot = (): DemoState => structuredClone(getState());
const order = (id: string) => getState().orders.find((o) => o.id === id)!;
const customer = (id: string) =>
  getState().customers.find((c) => c.id === id);

describe("an async staged handler never reaches live state", () => {
  beforeEach(() => {
    resetStore();
  });

  it("refuses to define one", () => {
    expect(() =>
      createStateTransitionCapability({
        name: "async_cancel",
        description: "Cancels an order after awaiting.",
        consequential: true,
        execute: (async () => {
          await Promise.resolve();
          mutate((draft) => {
            draft.orders.find((o) => o.id === "10428")!.status = "cancelled";
          });
        }) as never,
      }),
    ).toThrow(/async staged handler/);
  });

  it("leaves the order untouched when a handler suspends mid-stage", () => {
    const suspending = async () => {
      await Promise.resolve();
      mutate((draft) => {
        draft.orders.find((o) => o.id === "10428")!.status = "cancelled";
      });
    };

    expect(() => stage("suspending", suspending)).toThrow(
      /staged asynchronously/,
    );
    expect(order("10428").status).toBe("processing");
  });

  it("refuses later writes rather than letting the continuation land one", async () => {
    const suspending = async () => {
      await Promise.resolve();
      mutate((draft) => {
        draft.orders.find((o) => o.id === "10428")!.status = "cancelled";
      });
    };

    expect(() => stage("suspending", suspending)).toThrow();
    // The continuation is already scheduled. It resumes here, and the write
    // it carries is refused instead of landing unapproved.
    await Promise.resolve();
    await Promise.resolve();

    expect(order("10428").status).toBe("processing");
    expect(() => mutate(() => {})).toThrow(/refusing to write/);
  });
});

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
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    expect(approved.length).toBeGreaterThan(0);
    expect(deriveChanges(before, getState())).toEqual(approved);
  });
});

describe("a rejected proposal stops being visible", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clears the ghost when the human rejects", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });
    expect(stagedChangesFor("orders", "10428")).not.toEqual([]);

    runtime.reject(runtime.getSnapshot().pending[0]!.id, HUMAN);

    expect(stagedChangesFor("orders", "10428")).toEqual([]);
    expect(openProposalCount()).toBe(0);
    expect(order("10428").status).toBe("processing");
  });

  it("clears the ghost when the runtime resets", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });

    await runtime.reset();

    expect(openProposalCount()).toBe(0);
  });

  it("clears the ghost once the change lands", async () => {
    const runtime = await startRuntime();
    await runtime.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    expect(openProposalCount()).toBe(0);
    expect(stagedChangesFor("orders", "10428")).toEqual([]);
  });
});

describe("removals land", () => {
  beforeEach(() => {
    resetStore();
  });

  it("actually removes the duplicate that merge_customers previewed", async () => {
    const runtime = await startRuntime();
    const duplicate = getState().customers[1]!;
    const primary = getState().customers[0]!;

    const requested = await runtime.invoke("merge_customers", {
      primary_id: primary.id,
      duplicate_id: duplicate.id,
    });
    expect(requested.code).toBe("APPROVAL_REQUIRED");
    const approved = requested.data?.will_change as Change[];
    expect(approved).toContainEqual({
      field: `Customer ${duplicate.id}`,
      before: "present",
      after: "removed",
    });

    const before = snapshot();
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    expect(customer(duplicate.id)).toBeUndefined();
    expect(deriveChanges(before, getState())).toEqual(approved);
  });

  it("actually clears the notes that anonymize_customer previewed", async () => {
    const runtime = await startRuntime();
    mutate((draft) => {
      draft.customers[0]!.notes.push("Private: called about a billing error.");
    });
    const target = getState().customers[0]!;

    const requested = await runtime.invoke("anonymize_customer", {
      customer_id: target.id,
    });
    expect(requested.code).toBe("APPROVAL_REQUIRED");
    const approved = requested.data?.will_change as Change[];
    expect(
      approved.some((change) => change.field.includes("notes removed")),
    ).toBe(true);

    const before = snapshot();
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    expect(customer(target.id)!.notes).toEqual([]);
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

    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

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

    const result = await runtime.approve(
      runtime.getSnapshot().pending[0]!.id,
      HUMAN,
    );

    expect(result.data?.reasonCode).toBe("APPROVAL_STALE");
    expect(order("10428").status).toBe("on_hold");
    expect(
      getState().invoices.find((invoice) => invoice.orderId === "10428")!.status,
    ).toBe(invoiceBefore);
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
    await runtime.approve(runtime.getSnapshot().pending[1]!.id, HUMAN);

    const result = await runtime.approve(
      runtime.getSnapshot().pending[0]!.id,
      HUMAN,
    );

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

    const result = await runtime.approve(
      runtime.getSnapshot().pending[0]!.id,
      HUMAN,
    );

    expect(result.code).toBeUndefined();
    expect(order("10428").shippingRefunded).toBe(true);
    expect(order("10428").carrier).toBe("DHL");
  });
});

describe("a dependent plan previews against its own predecessors", () => {
  beforeEach(() => {
    resetStore();
  });

  it("derives operation two against what operation one staged", async () => {
    const runtime = await startRuntime();
    const plan = await runtime.prepare({
      operations: [
        {
          capability: "cancel_order",
          input: { order_id: "10428", reason: "Duplicate." },
        },
        {
          capability: "add_order_note",
          input: { order_id: "10428", note: "Cancelled as duplicate." },
        },
      ],
    });

    // Operation one is the only thing that puts the order into `cancelled`,
    // so seeing that as operation two's base proves the shared branch.
    expect(plan.operations[0]!.preview).toContainEqual({
      field: "Order #10428 status",
      before: "processing",
      after: "cancelled",
    });
    expect(order("10428").status).toBe("processing");

    const before = snapshot();
    runtime.approvePlan(plan.id, HUMAN);
    const committed = await runtime.commitPlan(plan.id);

    expect(committed.ok).toBe(true);
    expect(committed.plan?.status).toBe("COMMITTED");
    expect(order("10428").status).toBe("cancelled");
    expect(order("10428").notes).toContain("Cancelled as duplicate.");

    // The combined preview is exactly the landed change, in order.
    const landed = deriveChanges(before, getState());
    const previewed = plan.operations.flatMap((operation) => operation.preview);
    expect(new Set(landed.map((c) => c.field))).toEqual(
      new Set(previewed.map((c) => c.field)),
    );
  });

  it("refuses a plan whose second operation the first one invalidates", async () => {
    const runtime = await startRuntime();

    // Against live state both operations would stage cleanly and the human
    // would review a plan promising the same cancellation twice. Against the
    // shared branch the second one sees an order that is already cancelled.
    await expect(
      runtime.prepare({
        operations: [
          {
            capability: "cancel_order",
            input: { order_id: "10428", reason: "Duplicate." },
          },
          {
            capability: "cancel_order",
            input: { order_id: "10428", reason: "Duplicate." },
          },
        ],
      }),
    ).rejects.toThrow(/already cancelled/);

    expect(order("10428").status).toBe("processing");
    expect(openProposalCount()).toBe(0);
  });
});
