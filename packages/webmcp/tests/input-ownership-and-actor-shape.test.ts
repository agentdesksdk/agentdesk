import { describe, expect, it } from "vitest";
import { defineCapability, type Capability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

function runtimeWith(capabilities: readonly Capability[]) {
  const model = createMockModelContext();
  return createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities,
    actor: { id: "agent", name: "Agent", kind: "agent" },
  });
}

/** Cloneable for the first `cloneableReads`, then not. */
function shiftingInput(cloneableReads: number) {
  const state = { reads: 0 };
  return {
    state,
    input: {
      get order_id() {
        state.reads += 1;
        return state.reads <= cloneableReads ? "10428" : (() => "now a function");
      },
    } as unknown as Record<string, unknown>,
  };
}

describe("execution owns its input", () => {
  it("records the write it executed, or does not execute at all", async () => {
    const writes = { count: 0 };
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Writes once",
        risk: "WRITE",
        execute: () => {
          writes.count += 1;
          return receipt({
            entity: "Ledger",
            changes: [{ field: "value", before: 0, after: 1 }],
            result: { value: 1 },
          });
        },
      }),
    ]);
    await runtime.start();
    const { input } = shiftingInput(2);

    const outcome = await runtime.invoke("w", input);

    const terminal = runtime
      .getSnapshot()
      .audit.filter((e) => e.kind.startsWith("execution_"))
      .map((e) => e.kind);
    // A write that happened must be receipted. A write that was refused must
    // not have happened. Only those two shapes are honest.
    if (writes.count === 0) {
      expect({ failed: outcome.isError === true, receipts: runtime.queryReceipts().length })
        .toEqual({ failed: true, receipts: 0 });
    } else {
      expect({ writes: writes.count, receipts: runtime.queryReceipts().length, terminal })
        .toEqual({ writes: 1, receipts: 1, terminal: ["execution_started", "execution_completed"] });
    }
  });

  it("receipts the same input the handler ran against", async () => {
    const seen: unknown[] = [];
    const runtime = runtimeWith([
      defineCapability({
        name: "w",
        description: "Records what it was given",
        risk: "WRITE",
        execute: (input) => {
          seen.push(input.order_id);
          return receipt({
            entity: "Ledger",
            changes: [{ field: "order", before: null, after: input.order_id }],
            result: { order_id: input.order_id },
          });
        },
      }),
    ]);
    await runtime.start();
    // Answers a different order on every read. If the runtime keeps handing
    // the caller's object around, the receipt names an order the handler
    // never acted on.
    let reads = 0;
    const drifting = {
      get order_id() {
        reads += 1;
        return `order-${reads}`;
      },
    } as unknown as Record<string, unknown>;

    await runtime.invoke("w", drifting);

    expect(runtime.queryReceipts()[0]?.input).toEqual({ order_id: seen[0] });
  });
});

describe("an actor's name is optional", () => {
  const consequential = () =>
    defineCapability({
      name: "c",
      description: "Needs approval",
      risk: "CONSEQUENTIAL",
      approvalEvidence: "summary",
      execute: () => "done",
    });

  async function pending(runtime: ReturnType<typeof runtimeWith>) {
    await runtime.start();
    await runtime.invoke("c", {});
    return runtime.getSnapshot().pending[0]!.id;
  }

  it("approves with an identity that has no name", async () => {
    const runtime = runtimeWith([consequential()]);
    const id = await pending(runtime);

    const approved = await runtime.approve(id, { id: "human-1", kind: "human" });

    expect(approved.isError ?? false).toBe(false);
    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "approval_approved") as
      | { approvedBy?: { id: string } }
      | undefined;
    expect(event?.approvedBy?.id).toBe("human-1");
  });

  it("rejects with an identity that has no name", async () => {
    const runtime = runtimeWith([consequential()]);
    const id = await pending(runtime);

    const rejected = runtime.reject(id, { id: "human-1", kind: "human" });

    expect(rejected.isError ?? false).toBe(false);
    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "approval_rejected") as
      | { rejectedBy?: { id: string } }
      | undefined;
    expect(event?.rejectedBy?.id).toBe("human-1");
  });

  it("still refuses an identity whose name is present and malformed", async () => {
    const runtime = runtimeWith([consequential()]);
    const id = await pending(runtime);

    const approved = await runtime.approve(id, {
      id: "human-1",
      name: 7,
      kind: "human",
    } as never);

    expect(approved.isError).toBe(true);
  });
});
