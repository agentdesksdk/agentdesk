import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function refundFixture(store: { refunded: boolean }) {
  return defineCapability({
    name: "refund_shipping",
    description: "Refund the shipping fee",
    risk: "CONSEQUENTIAL",
    describeApproval: () => "Refund $18.00 shipping for Order #10428.",
    previewChanges: () => [
      { field: "Order #10428 shipping refunded", before: false, after: true },
      { field: "Invoice INV-3021 status", before: "due", after: "partially_refunded" },
    ],
    execute: () => {
      store.refunded = true;
      return receipt({
        entity: "Order #10428",
        changes: [
          { field: "Order #10428 shipping refunded", before: false, after: true },
          { field: "Credit issued", before: null, after: "CR-4001 · $18.00" },
        ],
        undoable: false,
        result: { order_id: "10428", shipping_refunded: true, amount: 18 },
      });
    },
  });
}

async function start(capability: ReturnType<typeof refundFixture>) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: [capability],
  });
  await runtime.start();
  return { model, runtime };
}

describe("change previews", () => {
  it("APPROVAL_REQUIRED carries what will change", async () => {
    const store = { refunded: false };
    const { runtime } = await start(refundFixture(store));
    const result = await runtime.invoke("refund_shipping", { order_id: "10428" });
    expect(result.data?.will_change).toEqual([
      { field: "Order #10428 shipping refunded", before: false, after: true },
      { field: "Invoice INV-3021 status", before: "due", after: "partially_refunded" },
    ]);
    expect(runtime.getSnapshot().pending[0]?.preview).toHaveLength(2);
    expect(store.refunded).toBe(false);
  });

  it("a throwing preview does not block the approval", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "risky_action",
          description: "Consequential with a broken preview",
          risk: "CONSEQUENTIAL",
          previewChanges: () => {
            throw new Error("preview exploded");
          },
          execute: () => "done",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("risky_action", {});
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.will_change).toBeUndefined();
    expect(runtime.getSnapshot().pending).toHaveLength(1);
  });
});

describe("change receipts", () => {
  it("execution returns a structured receipt alongside the result", async () => {
    const store = { refunded: false };
    const { runtime } = await start(refundFixture(store));
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;
    const approved = await runtime.approve(actionId);

    const payload = JSON.parse(approved.content[0]!.text) as {
      status: string;
      result: Record<string, unknown>;
      receipt: { entity: string; changes: unknown[]; undoable: boolean };
    };
    expect(payload.status).toBe("COMPLETED");
    expect(payload.result).toEqual({
      order_id: "10428",
      shipping_refunded: true,
      amount: 18,
    });
    expect(payload.receipt.entity).toBe("Order #10428");
    expect(payload.receipt.changes).toHaveLength(2);
    expect(payload.receipt.undoable).toBe(false);
  });

  it("the receipt is attached to the audit record", async () => {
    const store = { refunded: false };
    const { runtime } = await start(refundFixture(store));
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id);

    const completed = runtime
      .getSnapshot()
      .audit.find((event) => event.kind === "execution_completed");
    expect(completed).toBeDefined();
    if (completed?.kind === "execution_completed") {
      expect(completed.receipt?.entity).toBe("Order #10428");
      expect(completed.receipt?.changes[0]).toEqual({
        field: "Order #10428 shipping refunded",
        before: false,
        after: true,
      });
    }
  });

  it("get_action_status returns the receipt for later verification", async () => {
    const store = { refunded: false };
    const { model, runtime } = await start(refundFixture(store));
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const actionId = runtime.getSnapshot().pending[0]!.id;
    await runtime.approve(actionId);

    const status = (await model.execute("get_action_status", {
      approval_id: actionId,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(status.content[0]!.text) as {
      status: string;
      result: { receipt: { entity: string } };
    };
    expect(payload.status).toBe("APPROVED_EXECUTED");
    expect(payload.result.receipt.entity).toBe("Order #10428");
  });

  it("capabilities without receipts keep returning plain results", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "plain_read",
          description: "No receipt",
          execute: () => ({ ok: true }),
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("plain_read", {});
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
  });
});
