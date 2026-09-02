import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type PresentationEvent,
} from "../src/index.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };

/** A write whose presentation names a route and an anchor. */
const refund = defineCapability({
  name: "refund_shipping",
  description: "Refund the shipping fee for an order",
  risk: "WRITE",
  presentation: {
    route: (input) => `/orders/${String(input.order_id)}`,
    reveal: "shipping-summary",
    message: "Refunding shipping",
  },
  execute: (input) =>
    receipt({
      entity: `Order #${String(input.order_id)}`,
      changes: [{ field: "shipping_refunded", before: false, after: true }],
      result: { refunded: true },
    }),
});

async function booted() {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: [refund],
    actor: AGENT,
  });
  await runtime.start();
  const seen: PresentationEvent[] = [];
  runtime.subscribePresentation((event) => {
    seen.push(event);
  });
  return { runtime, model, seen };
}

describe("runtime.present: a page replays a reveal through the same bus", () => {
  it("delivers exactly the navigate-and-reveal event the runtime emits for a receipt naming that anchor", async () => {
    const { runtime, seen } = await booted();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    const emitted = seen.find((event) => event.phase === "capability_completed");
    expect(emitted).toMatchObject({
      capability: "refund_shipping",
      route: "/orders/10428",
      reveal: "shipping-summary",
    });
    seen.length = 0;

    runtime.present({
      capability: "refund_shipping",
      route: "/orders/10428",
      reveal: "shipping-summary",
    });

    expect(seen).toHaveLength(1);
    const replayed = seen[0]!;
    expect(replayed).toMatchObject({
      phase: "capability_completed",
      capability: "refund_shipping",
      route: "/orders/10428",
      reveal: "shipping-summary",
    });
    expect(typeof replayed.at).toBe("number");
    // A replay is not an execution: nothing only an execution can supply.
    expect(replayed).not.toHaveProperty("executionId");
    expect(replayed).not.toHaveProperty("humanInitiated");
    expect(replayed).not.toHaveProperty("actor");
  });

  it("changes no state and leaves the audit untouched", async () => {
    const { runtime, seen } = await booted();
    const before = runtime.getSnapshot().audit.length;

    runtime.present({ capability: "refund_shipping", route: "/orders/10428", reveal: "shipping-summary" });

    expect(seen).toHaveLength(1);
    expect(runtime.getSnapshot().audit).toHaveLength(before);
    expect(runtime.queryReceipts()).toEqual([]);
  });

  it("is not reachable through any WebMCP tool", async () => {
    const { runtime, model, seen } = await booted();

    expect(model.tools.has("present")).toBe(false);
    const viaInvoke = await runtime.invoke("invoke_capability", {
      name: "present",
      input: { capability: "refund_shipping", route: "/orders/10428", reveal: "shipping-summary" },
    });
    expect(viaInvoke.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("refuses a malformed request rather than emitting it", async () => {
    const { runtime, seen } = await booted();

    expect(() => runtime.present({ capability: "", route: "/orders/10428" })).toThrow(TypeError);
    expect(() => runtime.present({ capability: "refund_shipping", route: "orders/10428" })).toThrow(
      TypeError,
    );
    expect(() =>
      runtime.present({ capability: "refund_shipping", reveal: "not a token!" }),
    ).toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });
});
