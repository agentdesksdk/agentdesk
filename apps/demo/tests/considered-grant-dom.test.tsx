// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAction, RuntimeSnapshot } from "@agentdesk/webmcp";
import { ApprovalCards } from "../src/components/ApprovalCards.tsx";
import { resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

/**
 * The card reads its snapshot through `useRuntime`. Here that snapshot is
 * the page's own with the audit emptied and one pending action that
 * carries the grant the runtime consulted. The runtime sets
 * `pending.grant` at the request and it stays with the action; the audit
 * is bounded, so a pairing walked back from `approval_requested` to
 * `grant_not_applied` is gone once enough has happened since. The card
 * has to read the action, not the history.
 */
let snapshot: RuntimeSnapshot;

vi.mock("../src/components/hooks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/hooks.ts")>();
  return { ...actual, useRuntime: () => snapshot };
});

const ORDER = "10428";

function pending(extra: Partial<PendingAction>): PendingAction {
  return {
    id: "APR-77",
    capability: "refund_shipping",
    input: { order_id: ORDER },
    risk: "CONSEQUENTIAL",
    summary: `Refund $18.00 shipping for Order #${ORDER}.`,
    preview: [],
    createdAt: Date.now(),
    ...extra,
  } as PendingAction;
}

describe("the approval card names the grant the runtime considered", () => {
  beforeEach(() => {
    resetStore();
    snapshot = { ...agentdesk.getSnapshot(), audit: [], grants: [], pending: [] };
  });

  afterEach(cleanup);

  it("reads it off the pending action, with the audit emptied", () => {
    snapshot = {
      ...snapshot,
      pending: [pending({ grant: { id: "GRT-7", outcome: "exhausted" } } as Partial<PendingAction>)],
    };
    const view = render(<ApprovalCards />);
    const card = view.container.querySelector(".approval-card");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(
      "Grant GRT-7 was considered and did not apply: it is exhausted. A person decides.",
    );
  });

  it("names the bound the runtime reported, with no grant on record to read it from", () => {
    snapshot = {
      ...snapshot,
      pending: [
        pending({
          grant: { id: "GRT-8", outcome: "over_bound", field: "amount", max: 25 },
        } as Partial<PendingAction>),
      ],
    };
    const view = render(<ApprovalCards />);
    expect(view.container.querySelector(".approval-card")!.textContent).toContain(
      "Grant GRT-8 was considered and did not apply: it allows amount up to 25, and this call asked for more. A person decides.",
    );
  });

  it("says nothing about a grant when the action carries none", () => {
    snapshot = { ...snapshot, pending: [pending({})] };
    const view = render(<ApprovalCards />);
    const card = view.container.querySelector(".approval-card")!;
    expect(card.textContent).not.toContain("was considered");
    expect(card.querySelector(".considered-grant")).toBeNull();
  });
});
