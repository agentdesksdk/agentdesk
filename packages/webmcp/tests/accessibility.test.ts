import { describe, expect, it } from "vitest";
import type { AffectedObject } from "../src/results.ts";
import type { Actor } from "../src/plan.ts";
import type { PresentationEvent } from "../src/presentation.ts";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AFFECTED: AffectedObject[] = [
  {
    kind: "order",
    id: "10428",
    label: "Order #10428",
    reveal: "shipping-summary",
  },
];

function fixture() {
  return [
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      presentation: {
        route: (input) => `/orders/${String(input.order_id)}`,
        reveal: "shipping-summary",
        focus: "on_explicit_request",
        announce:
          "Shipping refund applied. The shipping summary shows the refunded fee.",
        message: "Preparing a shipping refund",
      },
      execute: () =>
        receipt({
          entity: "Order #10428",
          changes: [{ field: "shipping_refunded", before: false, after: true }],
          affected: AFFECTED,
          undoable: true,
          result: { amount: 18 },
        }),
    }),
    defineCapability({
      name: "add_order_note",
      description: "Adds a note to an order",
      risk: "WRITE",
      presentation: {
        reveal: "order-notes",
        focus: "on_explicit_request",
        announce: "Note added to the order.",
      },
      execute: () =>
        receipt({
          entity: "Order #10428",
          changes: [{ field: "notes", before: 0, after: 1 }],
          result: { ok: true },
        }),
    }),
    defineCapability({
      name: "quiet_capability",
      description: "Choreographs a route and a reveal, but claims no focus",
      risk: "WRITE",
      presentation: {
        route: (input) => `/orders/${String(input.order_id)}`,
        reveal: "order-items",
        message: "Opening the order",
      },
      execute: () => "done",
    }),
    defineCapability({
      name: "broken_capability",
      description: "Always throws",
      risk: "WRITE",
      presentation: { reveal: "order-items", announce: "Nothing changed." },
      execute: () => {
        throw new Error("store unreachable");
      },
    }),
  ];
}

async function startWithRecorder() {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: fixture(),
    actor: { id: "human-7", name: "Amein", kind: "human" },
  });
  await runtime.start();
  const events: PresentationEvent[] = [];
  runtime.subscribePresentation((event) => events.push(event));
  return { model, runtime, events };
}

function completed(events: PresentationEvent[]): PresentationEvent {
  const event = events.find((e) => e.phase === "capability_completed");
  expect(event).toBeDefined();
  return event!;
}

describe("focus policy and announcement reach the presentation event", () => {
  it("copies focus and announce from the capability presentation spec", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(completed(events)).toMatchObject({
      focus: "on_explicit_request",
      announce:
        "Shipping refund applied. The shipping summary shows the refunded fee.",
      reveal: "shipping-summary",
    });
  });

  it("leaves focus and announce undefined when the app declares neither", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);
    await runtime.invoke("quiet_capability", { order_id: "10428" });

    const declaring = events.find(
      (e) => e.phase === "capability_completed" && e.capability === "refund_shipping",
    );
    expect(declaring?.focus).toBe("on_explicit_request");
    expect(declaring?.announce).toBeDefined();

    const quiet = events.filter((e) => e.capability === "quiet_capability");
    expect(quiet.map((e) => e.phase)).toContain("capability_completed");
    for (const event of quiet) {
      expect(event.reveal).toBe("order-items");
      expect(event.focus).toBeUndefined();
      expect(event.announce).toBeUndefined();
    }
  });
});

describe("humanInitiated distinguishes an approval from background work", () => {
  it("is true on the execution an approve() authorized", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    expect(completed(events).humanInitiated).toBe(true);
  });

  it("is false on a plain invoke that never passed through approve()", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });

    expect(completed(events).humanInitiated).toBe(false);
  });

  it("is false on an agent tool call against the native surface", async () => {
    const { model, runtime, events } = await startWithRecorder();
    await runtime.routeTask("add order note");
    await model.execute("add_order_note", { order_id: "10428" });

    expect(completed(events).humanInitiated).toBe(false);
  });

  it("is false on an operation committed as part of an approved plan", async () => {
    const { runtime, events } = await startWithRecorder();
    const plan = await runtime.prepare({
      operations: [
        { capability: "add_order_note", input: { order_id: "10428" } },
      ],
    });
    runtime.approvePlan(plan.id, { id: "operator-1", name: "Amein", kind: "human" });
    await runtime.commitPlan(plan.id);

    expect(completed(events).humanInitiated).toBe(false);
  });
});

describe("executionId correlates a presentation event with its execution", () => {
  it("is present on capability_completed and matches the audit record", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });

    const audited = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed");
    expect(audited).toBeDefined();
    expect(completed(events).executionId).toBe(
      audited?.kind === "execution_completed" ? audited.executionId : undefined,
    );
  });

  it("is present on capability_failed, which is never human initiated here", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("broken_capability", {});

    const failed = events.find((e) => e.phase === "capability_failed");
    expect(failed?.executionId).toMatch(/^EXE-/);
    expect(failed?.humanInitiated).toBe(false);
  });

  it("is undefined before an execution exists", async () => {
    const { runtime, events } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });

    expect(events.map((e) => e.phase)).toEqual([
      "capability_started",
      "approval_requested",
    ]);
    for (const event of events) {
      expect(event.executionId).toBeUndefined();
    }

    await runtime.approve(runtime.getSnapshot().pending[0]!.id);
    expect(completed(events).executionId).toMatch(/^EXE-/);
  });
});

describe("affected objects survive verbatim wherever the receipt travels", () => {
  it("reaches the tool result, the audit event, and the stored receipt", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const result = await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    const payload = JSON.parse(result.content[0]!.text) as {
      receipt: { affected?: AffectedObject[] };
    };
    expect(payload.receipt.affected).toEqual(AFFECTED);

    const audited = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed");
    expect(
      audited?.kind === "execution_completed"
        ? audited.receipt?.affected
        : undefined,
    ).toEqual(AFFECTED);

    expect(runtime.queryReceipts()[0]?.receipt.affected).toEqual(AFFECTED);
  });

  it("is absent, not empty, when the application declares none", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);
    await runtime.invoke("add_order_note", { order_id: "10428" });

    const [note, refund] = runtime.queryReceipts();
    expect(refund?.capability).toBe("refund_shipping");
    expect(refund?.receipt.affected).toEqual(AFFECTED);
    expect(note?.capability).toBe("add_order_note");
    expect(note?.receipt).not.toHaveProperty("affected");
  });
});

describe("review state lives outside the immutable receipt", () => {
  it("marks a receipt reviewed once and records who reviewed it", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });
    const stored = runtime.queryReceipts()[0]!;
    expect(stored.reviewedAt).toBeUndefined();

    expect(runtime.markReviewed(stored.id)).toEqual({ ok: true });
    const reviewed = runtime.queryReceipts()[0]!;
    expect(reviewed.reviewedAt).toBeGreaterThan(0);
    expect(reviewed.reviewedBy?.id).toBe("human-7");
    expect(reviewed.receipt).toEqual(stored.receipt);
  });

  it("keeps who reviewed it beyond the caller's reach", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });
    const id = runtime.queryReceipts()[0]!.id;
    const reviewer: Actor = { id: "human-9", name: "Dana", kind: "human" };

    runtime.markReviewed(id, reviewer);
    reviewer.name = "Someone Else";
    reviewer.id = "human-1";

    expect(runtime.queryReceipts()[0]!.reviewedBy).toEqual({
      id: "human-9",
      name: "Dana",
      kind: "human",
    });
    expect(Object.isFrozen(runtime.queryReceipts()[0]!.reviewedBy)).toBe(true);
  });

  it("refuses a second review of the same receipt", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });
    const id = runtime.queryReceipts()[0]!.id;

    runtime.markReviewed(id);
    const again = runtime.markReviewed(id);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toContain("already reviewed");
    }
  });

  it("refuses an unknown receipt id", async () => {
    const { runtime } = await startWithRecorder();
    const missing = runtime.markReviewed("RCPT-999");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain("unknown receipt");
    }
  });

  it("appends a receipt_reviewed audit event naming the capability", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });
    const id = runtime.queryReceipts()[0]!.id;
    runtime.markReviewed(id);

    const audited = runtime
      .getSnapshot()
      .audit.filter((e) => e.kind === "receipt_reviewed");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      kind: "receipt_reviewed",
      capability: "add_order_note",
      receiptId: id,
    });
  });

  it("appends nothing when the review is refused", async () => {
    const { runtime } = await startWithRecorder();
    runtime.markReviewed("RCPT-999");

    expect(
      runtime.getSnapshot().audit.some((e) => e.kind === "receipt_reviewed"),
    ).toBe(false);
  });

  it("filters unreviewed receipts so a UI can list what still needs a look", async () => {
    const { runtime } = await startWithRecorder();
    await runtime.invoke("add_order_note", { order_id: "10428" });
    await runtime.invoke("add_order_note", { order_id: "10429" });
    const [newest, oldest] = runtime.queryReceipts();
    runtime.markReviewed(oldest!.id);

    expect(runtime.queryReceipts({ reviewed: false }).map((r) => r.id)).toEqual([
      newest!.id,
    ]);
    expect(runtime.queryReceipts({ reviewed: true }).map((r) => r.id)).toEqual([
      oldest!.id,
    ]);
    expect(runtime.queryReceipts()).toHaveLength(2);
  });
});
