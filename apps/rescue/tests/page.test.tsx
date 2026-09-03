// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { setGuidedPace } from "../src/Presence.tsx";
import { clearRevealed, revealedPanels } from "../src/reveal.ts";
import { OPERATOR, rescue, resetRescue } from "../src/runtime.ts";
import { getState, seed } from "../src/state.ts";

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Presses the agent's proposal and waits for the plan card. */
async function propose(view: RenderResult) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Propose the rescue/ }));
  });
  await settle(60);
  const plan = rescue.listPlans().find((p) => p.status === "DRAFT");
  if (!plan) {
    throw new Error("the agent did not stage a plan");
  }
  return { plan, card: view.getByRole("alertdialog", { name: new RegExp(`^Plan ${plan.id}:`) }) };
}

/**
 * The page's runtime requires a gesture token minted inside a user
 * activation; jsdom has none, so one is injected for the click it stands for.
 */
async function clickWithActivation(target: HTMLElement) {
  Object.defineProperty(navigator, "userActivation", { value: { isActive: true }, configurable: true });
  try {
    await act(async () => {
      fireEvent.click(target);
    });
  } finally {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: false }, configurable: true });
  }
}

describe("the mission screen", () => {
  beforeEach(async () => {
    await resetRescue();
    clearRevealed();
    setGuidedPace(5);
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(cleanup);

  it("the agent's proposal stages one plan through the gateway, the card shows the four operations and the consolidated diff, and live state is the seed", async () => {
    const view = render(<App />);
    const { plan, card } = await propose(view);
    expect(getState()).toEqual(seed());
    expect(card.textContent).toContain("CONSEQUENTIAL");
    expect(card.textContent).toContain("awaiting your approval");
    expect(within(card).getByRole("list", { name: "Operations in order" }).children).toHaveLength(4);
    const changes = [...within(card).getByRole("list", { name: "Consolidated changes" }).children].map((li) => li.textContent);
    expect(changes).toEqual([
      "Oxygen packs available6→4",
      "Drone NIA-7standby→assigned",
      "Dock 3 power20%→65%",
      "Mission AST-10428draft→launched",
    ]);
    const calls = [...within(view.getByRole("list", { name: "Tool calls the agent made" })).getAllByRole("listitem")].map(
      (li) => li.getAttribute("data-call"),
    );
    expect(calls).toEqual(["find_capabilities", "find_stranded_crew", "inspect_rescue_conditions", "prepare_plan"]);
    expect(plan.status).toBe("DRAFT");
  });

  it("an approval without a gesture token is refused; the card's click mints one, the agent commits, and the receipt ends with four verified lines", async () => {
    const view = render(<App />);
    const { plan, card } = await propose(view);

    // A bare actor cannot approve this runtime.
    const bare = rescue.approvePlan(plan.id, OPERATOR);
    expect(bare.ok).toBe(false);
    expect(rescue.getPlan(plan.id)?.status).toBe("DRAFT");

    await clickWithActivation(within(card).getByRole("button", { name: `Approve plan ${plan.id}` }));
    await settle(120);

    expect(rescue.getPlan(plan.id)?.status).toBe("COMMITTED");
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("launched");
    expect(view.container.querySelector('[data-field="oxygen"]')?.textContent).toBe("4 available");
    const receipt = view.getByRole("region", { name: "Rescue receipt AST-10428" });
    expect(receipt.textContent).toContain("RESCUE RECEIPT AST-10428");
    const lines = [...within(receipt).getByRole("list", { name: "Verified changes" }).children].map((li) => li.textContent);
    expect(lines).toEqual([
      "Oxygen packs available6→4verified",
      "Drone NIA-7standby→assignedverified",
      "Dock 3 power20%→65%verified",
      "Mission AST-10428draft→launchedverified",
    ]);
    // The card stays, in its committed state, with each operation's outcome in words.
    const settled = view.getByRole("region", { name: new RegExp(`^Plan ${plan.id}: committed`) });
    expect(settled.textContent).toContain("committed, every operation verified");
    expect(within(settled).queryByRole("button", { name: /^Approve/ })).toBeNull();
    // The client's log ends with commit_plan and query_receipts.
    const calls = [...within(view.getByRole("list", { name: "Tool calls the agent made" })).getAllByRole("listitem")].map(
      (li) => li.getAttribute("data-call"),
    );
    expect(calls.slice(-2)).toEqual(["commit_plan", "query_receipts"]);
    // The receipt is what the agent reads back through the control tools.
    const back = await rescue.invoke("invoke_capability", { name: "query_receipts", input: { plan_id: plan.id } });
    expect((JSON.parse(back.content[0]!.text) as { receipts: unknown[] }).receipts).toHaveLength(4);
  });

  it("guided execution moves attention across the four affected panels in the plan's order, and every completion is announced", async () => {
    const view = render(<App />);
    const { plan, card } = await propose(view);
    const spoken: string[] = [];
    const live = view.container.querySelector("[data-presence-announce]")!;
    new MutationObserver(() => spoken.push(live.textContent ?? "")).observe(live, { childList: true, characterData: true, subtree: true });

    await clickWithActivation(within(card).getByRole("button", { name: `Approve plan ${plan.id}` }));
    await settle(200);

    // The read lit the crew panel first; the plan then moves across the four affected panels in order.
    const lit = [...revealedPanels()];
    expect(lit[0]).toBe("panel-crew");
    expect(lit.slice(-4)).toEqual(["panel-oxygen", "panel-drone", "panel-dock", "panel-mission"]);
    // Focus does not move: the runtime marks an execution human-initiated only
    // through approve, and a plan is committed by the agent after approval, so
    // the handoff is never granted. Attention moves by highlight and announcement.
    expect(document.activeElement?.getAttribute("data-reveal") ?? null).toBeNull();
    expect(spoken.filter(Boolean)).toContain("Mission AST-10428 launched. The rescue is under way.");
  });

  it("reject leaves the seed, the card says so, and there is no receipt", async () => {
    const view = render(<App />);
    const { plan, card } = await propose(view);
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    });
    await settle(60);
    expect(getState()).toEqual(seed());
    expect(view.getByRole("region", { name: new RegExp(`^Plan ${plan.id}: rejected`) }).textContent).toContain("rejected, nothing ran");
    expect(view.queryByRole("region", { name: "Rescue receipt AST-10428" })).toBeNull();
    expect(view.container.querySelector("[data-client-outcome]")?.textContent).toContain("rejected");
  });

  it("reset restores the seed and clears the plan, the receipt, and the agent's calls", async () => {
    const view = render(<App />);
    const { plan, card } = await propose(view);
    await clickWithActivation(within(card).getByRole("button", { name: `Approve plan ${plan.id}` }));
    await settle(120);
    expect(getState().mission.status).toBe("launched");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset" }));
    });
    await settle(60);
    expect(getState()).toEqual(seed());
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");
    expect(view.queryByRole("region", { name: "Rescue receipt AST-10428" })).toBeNull();
    expect(view.container.querySelector("[data-plan]")).toBeNull();
    expect(view.queryByRole("list", { name: "Tool calls the agent made" })).toBeNull();
  });
});
