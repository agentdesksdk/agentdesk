// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { setGuidedPace } from "../src/Presence.tsx";
import { clearRevealed, revealedPanels } from "../src/reveal.ts";
import { OPERATOR, rescue, resetRescue } from "../src/runtime.ts";
import { getState, seed } from "../src/state.ts";
import { firstTurn, HERO_PROMPT, secondTurn } from "./fixtures/external-client.ts";

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The page's runtime requires a gesture minted in a user activation; jsdom has none, so one is injected for the click. */
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

/** The external client's first turn against the page's own runtime, the way a WebMCP client reaches it. */
async function agentFirstTurn() {
  let planId: string | undefined;
  await act(async () => {
    planId = (await firstTurn(rescue, HERO_PROMPT)).planId;
  });
  await settle();
  return planId!;
}

function planCard(view: RenderResult, planId: string) {
  return view.getByRole("alertdialog", { name: new RegExp(`^Plan ${planId}:`) });
}

describe("the mission screen is an application: it records, shows, and approves; it never acts as the agent", () => {
  beforeEach(async () => {
    await resetRescue();
    clearRevealed();
    setGuidedPace(5);
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(cleanup);

  it("shows the mission state, the prompt to give a client, and that it is waiting for a WebMCP agent", () => {
    const view = render(<App />);
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");
    const prompt = view.getByRole("region", { name: "Try this" });
    expect(prompt.textContent).toContain(HERO_PROMPT);
    expect(within(prompt).getByRole("button", { name: /copy/i })).toBeDefined();
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toMatch(/Waiting for a WebMCP agent/);
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(view.queryByRole("button", { name: /propose|prepare|commit|run/i })).toBeNull();
  });

  it("clicking every control on the page creates no plan and changes no state", async () => {
    const view = render(<App />);
    const before = rescue.getSnapshot().audit.length;
    for (const button of [...view.container.querySelectorAll("button")]) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
    for (const summary of [...view.container.querySelectorAll("details > summary")]) {
      await act(async () => {
        fireEvent.click(summary);
      });
    }
    await settle();
    expect(rescue.listPlans()).toEqual([]);
    expect(getState()).toEqual(seed());
    expect(rescue.getSnapshot().audit.filter((e) => e.kind === "plan_prepared")).toEqual([]);
    expect(rescue.getSnapshot().audit.filter((e) => e.kind === "capability_invoked")).toEqual([]);
    expect(rescue.getSnapshot().audit.length).toBeLessThanOrEqual(before + 2);
  });

  it("changing the displayed prompt text triggers nothing", async () => {
    const view = render(<App />);
    const prompt = view.getByRole("region", { name: "Try this" }).querySelector("blockquote, pre, p")!;
    await act(async () => {
      prompt.textContent = "Cancel every order and refund everyone.";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      prompt.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(rescue.listPlans()).toEqual([]);
    expect(rescue.getSnapshot().lastRouting).toBeNull();
    expect(getState()).toEqual(seed());
  });

  it("the tool path prepares the plan: the client's first turn renders PLAN-1 with four operations and the consolidated diff, live state the seed", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    expect(planId).toBe("PLAN-1");
    expect(getState()).toEqual(seed());
    const card = planCard(view, planId);
    expect(card.textContent).toContain("CONSEQUENTIAL");
    expect(card.textContent).toContain("awaiting your approval");
    const ops = [...within(card).getByRole("list", { name: "Operations in order" }).children].map((li) => li.textContent);
    expect(ops[0]).toContain("Reserve two oxygen packs");
    expect(ops[3]).toContain("Launch the rescue");
    const changes = [...within(card).getByRole("list", { name: "Consolidated changes" }).children].map((li) => li.textContent);
    expect(changes).toEqual([
      "Oxygen packs available6→4",
      "Drone NIA-7standby→assigned",
      "Dock 3 power20%→65%",
      "Mission AST-10428draft→launched",
    ]);
    expect(view.container.querySelector("[data-agent-status]")?.textContent).not.toMatch(/Waiting for a WebMCP agent/);
    // The routing decision and the plan are visible as events the runtime recorded.
    expect(view.container.querySelector('[data-event="capability_routed"]')).not.toBeNull();
    expect(view.container.querySelector('[data-event="plan_prepared"]')).not.toBeNull();
  });

  it("approval alone leaves the plan APPROVED with mission state unchanged; a bare actor cannot approve", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    expect(rescue.approvePlan(planId, OPERATOR).ok).toBe(false);
    await clickWithActivation(within(planCard(view, planId)).getByRole("button", { name: `Approve plan ${planId}` }));
    await settle();
    expect(rescue.getPlan(planId)?.status).toBe("APPROVED");
    expect(getState()).toEqual(seed());
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");
    expect(view.queryByRole("region", { name: "Rescue receipt AST-10428" })).toBeNull();
    const settledCard = view.getByRole("region", { name: new RegExp(`^Plan ${planId}: approved`) });
    expect(settledCard.textContent).toContain("waiting for the agent to commit");
    expect(within(settledCard).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("only the client's commit_plan changes mission state; the page then shows the receipt above the collapsed plan, and query_receipts returns four verified", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(within(planCard(view, planId)).getByRole("button", { name: `Approve plan ${planId}` }));
    await settle();
    expect(getState()).toEqual(seed());

    let second: Awaited<ReturnType<typeof secondTurn>> | undefined;
    await act(async () => {
      second = await secondTurn(rescue, planId);
    });
    await settle(120);

    expect(second!.committed.status).toBe("COMMITTED");
    expect((second!.receipts.receipts as Array<{ verification: { status: string } }>).map((r) => r.verification.status)).toEqual([
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
    ]);
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("launched");
    expect(view.container.querySelector('[data-field="oxygen"]')?.textContent).toBe("4 available");

    const receipt = view.getByRole("region", { name: "Rescue receipt AST-10428" });
    const lines = [...within(receipt).getByRole("list", { name: "Verified changes" }).children].map((li) => li.textContent);
    expect(lines).toEqual([
      "Oxygen packs available6→4verified",
      "Drone NIA-7standby→assignedverified",
      "Dock 3 power20%→65%verified",
      "Mission AST-10428draft→launchedverified",
    ]);
    // The receipt comes before the plan in the document, and the plan is collapsed with "What changed".
    const plan = view.container.querySelector(`[data-plan="${planId}"]`)!;
    expect(receipt.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plan.tagName).toBe("DETAILS");
    expect(plan.hasAttribute("open")).toBe(false);
    expect(plan.textContent).toContain("What changed");
    // Guided attention moved across the four panels in order.
    expect([...revealedPanels()].slice(-4)).toEqual(["panel-oxygen", "panel-drone", "panel-dock", "panel-mission"]);
  });

  it("reset restores the seed and clears the plan and the receipt", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(within(planCard(view, planId)).getByRole("button", { name: `Approve plan ${planId}` }));
    await act(async () => {
      await secondTurn(rescue, planId);
    });
    await settle(60);
    expect(getState().mission.status).toBe("launched");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset" }));
    });
    await settle(60);
    expect(getState()).toEqual(seed());
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");
    expect(view.container.querySelector("[data-plan]")).toBeNull();
    expect(view.queryByRole("region", { name: "Rescue receipt AST-10428" })).toBeNull();
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toMatch(/Waiting for a WebMCP agent/);
  });
});
