// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolResult } from "@agentdesk/webmcp";
import { ActivityPanel } from "../src/components/ActivityPanel.tsx";
import { ApprovalCards } from "../src/components/ApprovalCards.tsx";
import { GrantCard } from "../src/components/GrantCard.tsx";
import { Inspector } from "../src/components/Inspector.tsx";
import { getState, resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

const ORDER = "10428";
const CARD = `Agent authority on order #${ORDER}`;
const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

/**
 * The order page's grant card next to the three surfaces a grant shows up
 * on: the Inspector's authority line, the activity rail's receipts, and the
 * approval overlay. The rail needs a route to navigate from.
 */
function mount(): RenderResult {
  return render(
    <MemoryRouter initialEntries={[`/agentdesk/orders/${ORDER}`]}>
      <Routes>
        <Route
          path="/:mode/orders/:id"
          element={
            <>
              <GrantCard orderId={ORDER} />
              <Inspector />
              <ActivityPanel />
              <ApprovalCards />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const approvalCard = (view: RenderResult) => view.container.querySelector(".approval-card");
const authority = (view: RenderResult) =>
  view.container.querySelector("[data-authority]")?.textContent ?? "";
const order = () => getState().orders.find((o) => o.id === ORDER)!;
const liveGrant = () => agentdesk.getSnapshot().grants.find((g) => g.state === "live");

/** Issues a grant the way the person does: through the card's form. */
async function issue(view: RenderResult, uses: number) {
  const card = view.getByRole("region", { name: CARD });
  fireEvent.change(within(card).getByLabelText("Uses"), { target: { value: String(uses) } });
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: /^Grant/ }));
  });
  const grant = liveGrant();
  if (!grant) {
    throw new Error("the card did not issue a live grant");
  }
  return grant;
}

/** The agent's call, exactly what a WebMCP client's refund_shipping does. */
async function refund(): Promise<ToolResult> {
  let result: ToolResult | undefined;
  await act(async () => {
    result = await agentdesk.invoke("refund_shipping", { order_id: ORDER });
  });
  return result!;
}

const payload = (result: ToolResult) =>
  JSON.parse(result.content[0]!.text) as { status: string };

/** Pumped with timers, not rAF, so a test counting rAF counts only the hook's. */
async function frames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("the grant card on order 10428", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    resetStore();
    await agentdesk.setExposure("routed");
    await agentdesk.setContext({ route: `/orders/${ORDER}`, state: { orderId: ORDER } });
  });

  afterEach(() => {
    cleanup();
  });

  it("issuing a grant lets the next in-scope refund execute with no approval card, and the receipt names the grant", async () => {
    const view = mount();
    expect(approvalCard(view)).toBeNull();
    expect(order().shippingRefunded).toBe(false);

    const grant = await issue(view, 1);
    expect(grant.capability).toBe("refund_shipping");
    expect(grant.scope).toContainEqual({ field: "order_id", kind: "exact", value: ORDER });

    const card = view.getByRole("region", { name: CARD });
    expect(card.textContent).toContain(grant.id);
    expect(card.textContent).toContain("1 of 1");

    const result = await refund();
    expect(result.code).toBeUndefined();
    expect(payload(result).status).toBe("COMPLETED");
    expect(approvalCard(view)).toBeNull();
    expect(agentdesk.getSnapshot().pending).toEqual([]);
    expect(order().shippingRefunded).toBe(true);

    const authorized = agentdesk.queryReceipts({ grantId: grant.id });
    expect(authorized).toHaveLength(1);
    expect(authorized[0]!.grantId).toBe(grant.id);
    const receipt = view.getByRole("region", { name: "Receipt for Order #10428" });
    expect(receipt.textContent).toContain(`grant ${grant.id}`);
    // The spend shows on the card too, as text.
    expect(card.textContent).toContain("0 of 1");
  });

  it("the second use after uses: 1 asks a person, and the card names the grant as exhausted", async () => {
    const view = mount();
    const grant = await issue(view, 1);
    await refund();
    const entry = agentdesk.queryReceipts({ grantId: grant.id })[0]!;

    // Undo puts the order back where it was, so the same call is possible
    // again; the mandate, though, has been spent.
    await act(async () => {
      const undone = await agentdesk.rollback(entry.id);
      expect(undone.ok).toBe(true);
    });
    expect(order().shippingRefunded).toBe(false);
    expect(agentdesk.getGrant(grant.id)?.state).toBe("exhausted");

    const result = await refund();
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.grant).toEqual({ id: grant.id, outcome: "exhausted" });
    expect(order().shippingRefunded).toBe(false);

    const approval = approvalCard(view);
    expect(approval).not.toBeNull();
    expect(approval!.textContent).toContain(grant.id);
    expect(approval!.textContent).toContain("exhausted");
    const card = view.getByRole("region", { name: CARD });
    expect(card.textContent).toContain("exhausted");
    expect(within(card).queryByRole("button", { name: /^Revoke/ })).toBeNull();
  });

  it("Revoke is immediate: the next use goes to approval, and the card names the grant as revoked", async () => {
    const view = mount();
    const grant = await issue(view, 2);
    const card = view.getByRole("region", { name: CARD });

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: `Revoke grant ${grant.id}` }));
    });
    const revoked = agentdesk.getGrant(grant.id);
    expect(revoked?.state).toBe("revoked");
    expect(revoked?.remaining).toBe(2);
    expect(within(card).queryByRole("button", { name: /^Revoke/ })).toBeNull();
    expect(card.textContent).toContain("revoked");
    // The control that held focus is gone; focus lands on the card.
    expect(document.activeElement).toBe(card);

    const result = await refund();
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.grant).toEqual({ id: grant.id, outcome: "revoked" });
    expect(agentdesk.getSnapshot().pending).toHaveLength(1);
    expect(order().shippingRefunded).toBe(false);

    const approval = approvalCard(view);
    expect(approval).not.toBeNull();
    expect(approval!.textContent).toContain(grant.id);
    expect(approval!.textContent).toContain("revoked");
  });

  it("the Inspector's authority line reads from the snapshot, not a constant", async () => {
    const view = mount();
    expect(authority(view)).toBe("read + propose");

    const grant = await issue(view, 2);
    expect(authority(view)).toBe(`refund shipping ≤ 2 uses on order ${ORDER}`);

    await refund();
    expect(agentdesk.getGrant(grant.id)?.remaining).toBe(1);
    expect(authority(view)).toBe(`refund shipping ≤ 1 use on order ${ORDER}`);

    await act(async () => {
      agentdesk.revokeGrant(grant.id, HUMAN);
    });
    expect(authority(view)).toBe("read + propose");
  });

  it("announces a grant once when issued and once when revoked", async () => {
    const view = mount();
    const card = view.getByRole("region", { name: CARD });
    const region = card.querySelector('[role="status"]')!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const grant = await issue(view, 3);
    await frames(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("3 uses");
    expect(seen[0]).toContain(ORDER);

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: `Revoke grant ${grant.id}` }));
    });
    await frames(3);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(grant.id);
    expect(seen[1]).toContain("evoked");
  });
});
