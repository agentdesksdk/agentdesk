import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { receipt } from "../src/results.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import type { Actor } from "../src/plan.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const MALFORMED: Array<[string, unknown]> = [
  ["no id at all", { kind: "agent" }],
  ["empty id", { id: "", kind: "agent" }],
  ["blank id", { id: "   ", kind: "agent" }],
  ["non-string id", { id: 42, kind: "agent" }],
  ["null id", { id: null, kind: "agent" }],
  ["unknown kind", { id: "agent-a", kind: "robot" }],
  ["non-string name", { id: "agent-a", kind: "agent", name: 7 }],
  ["a string", "agent-a"],
];

function noteCapability() {
  return defineCapability({
    name: "add_order_note",
    description: "Adds a note",
    risk: "WRITE",
    execute: () =>
      receipt({
        entity: "Order #10428",
        changes: [{ field: "notes", before: 0, after: 1 }],
        result: { ok: true },
      }),
  });
}

function build(actor: unknown) {
  const model = createMockModelContext();
  return createAgentDeskRuntime({
    registerTool: model.registerTool,
    actor: actor as Actor,
    capabilities: [noteCapability()],
  });
}

describe("the ambient identity is parsed like any other", () => {
  it("refuses a malformed actor at construction", () => {
    for (const [label, supplied] of MALFORMED) {
      expect(() => build(supplied), label).toThrow(TypeError);
    }
  });

  it("refuses a malformed actor handed to setActor", async () => {
    for (const [label, supplied] of MALFORMED) {
      const runtime = build({ id: "agent-a", kind: "agent" });
      await runtime.start();

      expect(() => runtime.setActor(supplied as Actor), label).toThrow(TypeError);
      expect(runtime.getSnapshot().actor?.id, label).toBe("agent-a");
    }
  });

  it("never attributes an execution to an anonymous actor", async () => {
    const runtime = build({ id: "agent-a", kind: "agent" });
    await runtime.start();
    try {
      runtime.setActor({ kind: "agent" } as Actor);
    } catch {
      // The refusal is the point; the run below proves nothing leaked.
    }
    await runtime.invoke("add_order_note", {});

    const completed = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed");
    const actor = (completed as { actor?: { id?: string } }).actor;
    expect(actor?.id).toBe("agent-a");
    expect(runtime.queryReceipts()[0]?.executedBy?.id).toBe("agent-a");
  });

  it("still accepts a well formed ambient actor", async () => {
    const runtime = build({ id: "agent-a", name: "A", kind: "agent" });
    await runtime.start();
    runtime.setActor({ id: "agent-b", kind: "agent" });

    expect(runtime.getSnapshot().actor?.id).toBe("agent-b");
  });
});
