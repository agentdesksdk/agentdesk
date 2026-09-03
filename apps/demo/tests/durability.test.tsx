// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryPersistence, type ToolResult } from "@agentdesksdk/webmcp";
import { armCommitFault } from "../src/capabilities/staged.ts";
import { getState, resetStore } from "../src/data/store.ts";
import { createMeridianRuntime } from "../src/runtime/agentdesk.ts";
import { demoResolveArtifact } from "../src/runtime/persistence.ts";

const ORDER = "10428";
/** One key for the one call, so the second attempt is the same call. */
const KEY = `durability-${ORDER}`;
const OPERATOR = { id: "operator", name: "Operator", kind: "human" as const };

type Runtime = ReturnType<typeof createMeridianRuntime>;

/** A memory adapter standing in for IndexedDB, with the demo's resolver on it. */
function adapterInMemory() {
  const adapter = memoryPersistence();
  adapter.resolveArtifact = demoResolveArtifact;
  return adapter;
}

/** The call, sent the way a client sends it: by name, with an idempotency key. */
const THE_CALL = { name: "refund_shipping", input: { order_id: ORDER }, idempotency_key: KEY };

/** How many times a person has been asked, so a repeat can be shown not to ask again. */
function approvalsAsked(runtime: Runtime): number {
  return runtime.getSnapshot().audit.filter((e) => e.kind === "approval_requested").length;
}

/**
 * The interrupted operation: a shipping refund whose commit writes and then
 * throws. The refund is consequential, so the call asks for approval and a
 * person approves it; the runtime then cannot know whether the write landed,
 * so it records an unreconciled outcome instead of a success or a failure.
 */
async function interrupt(runtime: Runtime): Promise<ToolResult> {
  armCommitFault("refund_shipping");
  const asked = await runtime.invoke("invoke_capability", THE_CALL);
  expect(asked.code, asked.content[0]?.text).toBe("APPROVAL_REQUIRED");
  const actionId = runtime.getSnapshot().pending[0]!.id;
  const done = await runtime.approve(actionId, OPERATOR);
  expect(done.code, done.content[0]?.text).toBe("EXECUTION_INDETERMINATE");
  return done;
}

describe("an unknown outcome survives a restart of Meridian Ops", () => {
  beforeEach(() => {
    resetStore();
  });

  it("is listed after a fresh start on the same adapter, with what it carried", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);

    const before = first.listUnreconciled();
    expect(before).toHaveLength(1);
    const record = before[0]!;
    expect(record.kind).toBe("commit_indeterminate");
    expect(record.capability).toBe("refund_shipping");
    expect(record.operationKey).toBeDefined();
    expect(record.executedBy).toBeDefined();
    // Authorized by the person's approval, not by a grant.
    expect(record.actionId).toBeDefined();
    expect(record.grantId).toBeUndefined();
    expect(record.changes.map((c) => c.field)).toContain(`Order #${ORDER} shipping refunded`);
    // The fork is not cloneable, so it was written down by the identity the
    // staging adapter gave it, not as two copies of the document.
    const saved = [...adapter.records.values()];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.artifact.kind).toBe("reference");
    expect(JSON.stringify(saved[0]!.artifact)).toContain("refund_shipping");
    await first.stop();

    // A reload: a new runtime, the same store on disk.
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    const after = second.listUnreconciled();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(record.id);
    expect(after[0]!.operationKey).toBe(record.operationKey);
    expect(after[0]!.executedBy).toEqual(record.executedBy);
    expect(after[0]!.actionId).toBe(record.actionId);
    expect(after[0]!.grantId).toBeUndefined();
    expect(JSON.stringify(after[0]!.changes)).toBe(JSON.stringify(record.changes));
    await second.stop();
  });

  it("refuses the same call again after the restart, with its cause, before any approval is asked", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);
    await first.stop();

    // The reload: a fresh runtime on the same adapter, and the document back
    // at its seed, which is what a page gets.
    resetStore();
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    // Refused twice over. While the record is open, its operation key guards
    // the same call ahead of the approval gate: the runtime names the
    // record, asks nobody, and executes nothing.
    const id = second.listUnreconciled()[0]!.id;
    const guarded = await second.invoke("invoke_capability", THE_CALL);
    expect(guarded.code, guarded.content[0]?.text).toBe("EXECUTION_INDETERMINATE");
    expect(guarded.data?.record_id).toBe(id);
    expect(approvalsAsked(second)).toBe(0);
    expect(second.getSnapshot().pending).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    // Once a person settles the record, the claim the approval request made
    // on the key still survives, and the same call is refused for that
    // reason, never replayed and never asked again.
    expect(second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR)).toEqual({ ok: true });
    const again = await second.invoke("invoke_capability", THE_CALL);
    expect(again.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(again.data?.cause).toBe("after_restart");
    expect(String(again.data?.reason)).toMatch(/restart/);
    expect(approvalsAsked(second)).toBe(0);
    expect(second.getSnapshot().pending).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    await second.stop();
  });

  it("reconciles the rehydrated record exactly once, through the rebuilt fork, and the list empties", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);
    const id = first.listUnreconciled()[0]!.id;
    await first.stop();

    // The reload: the fork is rebuilt from the identity the record kept,
    // against the document as the page finds it, its seed.
    resetStore();
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    const settled = second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR);
    expect(settled).toEqual({ ok: true });
    expect(second.listUnreconciled()).toEqual([]);
    expect(adapter.records.size).toBe(0);
    expect(
      second.getSnapshot().audit.filter((e) => e.kind === "staged_reconciled" && e.recordId === id),
    ).toHaveLength(1);
    const twice = second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR);
    expect(twice.ok).toBe(false);
    await second.stop();
  });
});

