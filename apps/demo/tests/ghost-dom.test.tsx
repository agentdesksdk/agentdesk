// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ghost } from "../src/components/Ghost.tsx";
import { agentdesk } from "../src/runtime/agentdesk.ts";
import { getState, resetStore } from "../src/data/store.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

const pendingId = () => agentdesk.getSnapshot().pending[0]!.id;

/**
 * jsdom has no user activation. The runtime reads the platform's answer
 * through `navigator.userActivation`, so the test injects one that is in
 * progress for the duration of the click it stands for.
 */
async function approveFromClick(id: string): Promise<void> {
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive: true },
    configurable: true,
  });
  try {
    await agentdesk.approve(id, agentdesk.issueApprovalGesture({ actionId: id }, HUMAN));
  } finally {
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
      configurable: true,
    });
  }
}

async function proposeCancellation() {
  await act(async () => {
    await agentdesk.invoke("cancel_order", {
      order_id: "10428",
      reason: "Customer changed their mind.",
    });
  });
}

describe("the ghost shows only what is still proposed", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the staged change and clears it when the human rejects", async () => {
    const view = render(<Ghost collection="orders" id="10428" />);
    expect(view.container.textContent).toBe("");

    await proposeCancellation();
    expect(view.container.textContent).toContain("not yet applied");
    expect(view.container.textContent).toContain("Order #10428 status");
    // The order itself has not moved, so the ghost is a proposal rather than
    // a report of something that happened.
    expect(getState().orders.find((o) => o.id === "10428")!.status).toBe(
      "processing",
    );

    const id = pendingId();
    await act(async () => {
      agentdesk.reject(id, HUMAN);
    });

    expect(view.container.textContent).toBe("");
  });

  it("clears the ghost once the change lands", async () => {
    const view = render(<Ghost collection="orders" id="10428" />);
    await proposeCancellation();
    expect(view.container.textContent).toContain("Order #10428 status");

    const id = pendingId();
    await act(async () => {
      await approveFromClick(id);
    });

    expect(view.container.textContent).toBe("");
    expect(getState().orders.find((o) => o.id === "10428")!.status).toBe(
      "cancelled",
    );
  });
});
