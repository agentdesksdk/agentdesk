import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  type AppContext,
  type PresentationEvent,
} from "@agentdesk/webmcp";
import { capabilities } from "../src/capabilities/index.ts";
import {
  reviewedAnnouncement,
  rollbackRefusedAnnouncement,
  rolledBackAnnouncement,
} from "../src/components/receipt-text.ts";
import { isRegisteredRevealToken, shouldHandOffFocus } from "../src/components/reveal.ts";
import { resetStore } from "../src/data/store.ts";

function refundCapability() {
  const found = capabilities.find((c) => c.name === "refund_shipping");
  expect(found).toBeDefined();
  return found!;
}

async function startRuntime() {
  const runtime = createAgentDeskRuntime({
    capabilities,
    registerTool: async () => {},
    actor: { id: "human-7", name: "Amein", kind: "human" },
  });
  await runtime.start();
  const events: PresentationEvent[] = [];
  runtime.subscribePresentation((event) => events.push(event));
  return { runtime, events };
}

function completedEvent(event: Partial<PresentationEvent>): PresentationEvent {
  return {
    phase: "capability_completed",
    capability: "refund_shipping",
    reveal: "shipping-summary",
    focus: "on_explicit_request",
    humanInitiated: true,
    executionId: "EXE-1",
    at: 0,
    ...event,
  };
}

describe("the refund capability declares its accessibility contract", () => {
  it("asks for focus only on an explicit human request", () => {
    expect(refundCapability().presentation?.focus).toBe("on_explicit_request");
  });

  it("carries a screen reader sentence naming the entity and the outcome", () => {
    const announce = refundCapability().presentation?.announce;
    expect(typeof announce).toBe("function");
    const spoken = (announce as (i: Record<string, unknown>, c: AppContext) => string)(
      { order_id: "10428" },
      { route: "/orders/10428", state: {} },
    );
    expect(spoken).toMatch(/refund/i);
    // Someone who cannot see the screen needs to know which order moved.
    expect(spoken).toContain("10428");
  });

  it("falls back to a sentence without an entity when the order is unknown", () => {
    const announce = refundCapability().presentation?.announce as (
      i: Record<string, unknown>,
      c: AppContext,
    ) => string;
    const spoken = announce({}, { route: "/orders", state: {} });
    expect(spoken).toMatch(/refund/i);
    expect(spoken).not.toContain("undefined");
  });

  it("leaves every other capability without a focus policy", () => {
    const others = capabilities.filter((c) => c.name !== "refund_shipping");
    for (const capability of others) {
      expect(capability.presentation?.focus).toBeUndefined();
    }
  });
});

describe("the refund receipt names the object a human can navigate to", () => {
  beforeEach(() => {
    resetStore();
  });

  it("records the order as an affected object pointing at a registered reveal", async () => {
    const { runtime } = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });

    const stored = runtime.queryReceipts({ capability: "refund_shipping" })[0]!;
    expect(stored.receipt.affected).toEqual([
      {
        kind: "order",
        id: "10428",
        label: "Order #10428",
        reveal: "shipping-summary",
      },
    ]);
  });

  it("hands the completed event a human initiated flag the UI can act on", async () => {
    const { runtime, events } = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });

    const done = events.find((e) => e.phase === "capability_completed")!;
    expect(shouldHandOffFocus(done, undefined)).toBe(true);
  });

  it("refuses focus for the same refund run without an approval", async () => {
    const { runtime, events } = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });
    const approved = events.find((e) => e.phase === "capability_completed")!;

    expect(approved.focus).toBe("on_explicit_request");
    expect(approved.reveal).toBe("shipping-summary");
    expect(
      shouldHandOffFocus({ ...approved, humanInitiated: false }, undefined),
    ).toBe(false);
  });

  it("narrows the event so the caller can trust the id and the target", async () => {
    const { runtime, events } = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });
    const done = events.find((e) => e.phase === "capability_completed")!;

    expect(shouldHandOffFocus(done, undefined)).toBe(true);
    if (shouldHandOffFocus(done, undefined)) {
      const executionId: string = done.executionId;
      const reveal: string = done.reveal;
      expect(executionId).toMatch(/^EXE-/);
      expect(reveal).toBe("shipping-summary");
    }
  });
});

describe("focus handoff refuses everything an agent could drive on its own", () => {
  it("moves focus for a human authorized completion with a reveal target", () => {
    expect(shouldHandOffFocus(completedEvent({}), undefined)).toBe(true);
  });

  it("moves focus at most once per execution", () => {
    const event = completedEvent({ executionId: "EXE-4" });
    expect(shouldHandOffFocus(event, "EXE-4")).toBe(false);
    expect(shouldHandOffFocus(event, "EXE-3")).toBe(true);
  });

  it("never moves focus when the work was not human initiated", () => {
    expect(
      shouldHandOffFocus(completedEvent({ humanInitiated: false }), undefined),
    ).toBe(false);
  });

  it("never moves focus when the policy is absent", () => {
    const { focus: _focus, ...withoutPolicy } = completedEvent({});
    expect(shouldHandOffFocus(withoutPolicy, undefined)).toBe(false);
  });

  it("never moves focus when the policy is never", () => {
    expect(shouldHandOffFocus(completedEvent({ focus: "never" }), undefined)).toBe(
      false,
    );
  });

  it("never moves focus before the action completed", () => {
    expect(
      shouldHandOffFocus(
        completedEvent({ phase: "capability_started" }),
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldHandOffFocus(
        completedEvent({ phase: "approval_requested" }),
        undefined,
      ),
    ).toBe(false);
  });

  it("never moves focus without a reveal target the application registered", () => {
    const { reveal: _reveal, ...withoutTarget } = completedEvent({});
    expect(shouldHandOffFocus(withoutTarget, undefined)).toBe(false);
  });

  it("never moves focus to a reveal token the application could not have registered", () => {
    expect(
      shouldHandOffFocus(
        completedEvent({ reveal: 'x"] , [data-reveal="secret' }),
        undefined,
      ),
    ).toBe(false);
  });
});

describe("only an opaque registered token reaches querySelector", () => {
  it("accepts the tokens the application actually registers", () => {
    for (const token of [
      "shipping-summary",
      "order-items",
      "customer-credits",
      "a",
      "A1",
      "x-1-y",
    ]) {
      expect(isRegisteredRevealToken(token)).toBe(true);
    }
  });

  it("refuses selector injection, traversal, and anything with structure", () => {
    for (const token of [
      'a"], [data-reveal="b',
      "*",
      "a b",
      "..",
      "",
      'a"b',
      "a\\b",
      "a\nb",
      "[data-reveal]",
      "#secret",
      ".panel",
      "-leading-dash",
      "a,b",
      "a:focus",
      "a>b",
    ]) {
      expect(isRegisteredRevealToken(token)).toBe(false);
    }
  });
});

describe("every reveal anchor carries an accessible name", () => {
  const ANCHOR = /<[a-zA-Z][^<>]*\bdata-reveal="[a-z0-9-]+"[^<>]*>/g;

  it("names every panel a reveal can land focus on", () => {
    const routes = readdirSync(new URL("../src/routes/", import.meta.url));
    const anchors: string[] = [];
    for (const file of routes) {
      const source = readFileSync(
        new URL(`../src/routes/${file}`, import.meta.url),
        "utf8",
      );
      anchors.push(...(source.match(ANCHOR) ?? []));
    }

    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor).toContain('role="region"');
      expect(anchor).toContain("aria-label");
    }
  });
});

describe("review and rollback say what they did", () => {
  beforeEach(() => {
    resetStore();
  });

  async function refundReceipt() {
    const { runtime } = await startRuntime();
    await runtime.invoke("refund_shipping", { order_id: "10428" });
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, { id: "operator", name: "Operator", kind: "human" });
    return {
      runtime,
      entry: runtime.queryReceipts({ capability: "refund_shipping" })[0]!,
    };
  }

  it("names the action and the entity when a receipt is marked reviewed", async () => {
    const { entry } = await refundReceipt();
    expect(reviewedAnnouncement(entry)).toBe(
      "Marked reviewed. Refund shipping on Order #10428.",
    );
  });

  it("names the action and the entity when a receipt is rolled back", async () => {
    const { entry } = await refundReceipt();
    expect(rolledBackAnnouncement(entry)).toBe(
      "Rolled back refund shipping on Order #10428.",
    );
  });

  it("carries the runtime's reason when a rollback is refused", async () => {
    const { runtime, entry } = await refundReceipt();
    const first = await runtime.rollback(entry.id);
    expect(first.ok).toBe(true);
    const again = await runtime.rollback(entry.id);
    expect(again.ok).toBe(false);

    if (!again.ok) {
      expect(rollbackRefusedAnnouncement(entry, again.reason)).toBe(
        `Could not roll back refund shipping on Order #10428. ${entry.id} was already rolled back`,
      );
    }
  });
});
