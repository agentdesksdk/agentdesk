// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  vi.resetModules();
});

describe("Meridian reload durability", () => {
  it("loads the committed application state after a module reload", async () => {
    const first = await import("../src/data/store.ts");
    first.resetStore();
    first.mutate((state) => {
      state.orders[0]!.status = "cancelled";
    });

    vi.resetModules();
    const reloaded = await import("../src/data/store.ts");
    expect(reloaded.getCommittedState().orders[0]!.status).toBe("cancelled");
  });

  it("restores a pending refund, its receipt, and its idempotent result", async () => {
    const store = await import("../src/data/store.ts");
    const { createDemoPersistence } = await import("../src/runtime/persistence.ts");
    const { createMeridianRuntime, OPERATOR } = await import(
      "../src/runtime/agentdesk.ts"
    );
    store.resetStore();
    const persistence = createDemoPersistence(undefined, localStorage).adapter;
    const call = {
      name: "refund_shipping",
      input: { order_id: "10428" },
      idempotency_key: "reload-refund-10428",
    };

    const first = createMeridianRuntime({ persistence });
    await first.start();
    const asked = await first.invoke("invoke_capability", call);
    const actionId = String(asked.data?.approval_id);
    await first.stop();

    const second = createMeridianRuntime({ persistence });
    await second.start();
    expect(second.getSnapshot().pending[0]?.id).toBe(actionId);
    const completed = await second.approve(actionId, OPERATOR);
    expect(completed.data?.status).toBe("COMPLETED");
    expect(
      store.getCommittedState().orders.find((order) => order.id === "10428")
        ?.shippingRefunded,
    ).toBe(true);
    const receiptId = second.queryReceipts({ capability: "refund_shipping" })[0]?.id;
    expect(receiptId).toMatch(/^RCPT-/);
    await second.stop();

    const third = createMeridianRuntime({ persistence });
    await third.start();
    expect(third.queryReceipts({ capability: "refund_shipping" })[0]?.id).toBe(receiptId);
    expect(await third.invoke("invoke_capability", call)).toEqual(completed);
  });
});
