// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
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

describe("the mission screen is an application: it records, shows, and authorizes; it never acts as the agent", () => {
  beforeEach(async () => {
    await resetRescue();
    clearRevealed();
    setGuidedPace(5);
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(cleanup);

  it("shows the objective to give a client, waits for a WebMCP agent, and keeps the Inspector closed", () => {
    const view = render(<App />);
    const objective = view.getByRole("region", { name: "Objective" });
    expect(objective.textContent).toContain(HERO_PROMPT);
    expect(within(objective).getByRole("button", { name: /copy/i })).toBeDefined();
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toBe("Waiting for a WebMCP agent");
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(view.queryByRole("button", { name: /propose|prepare|commit|run|launch/i })).toBeNull();
    const inspector = view.container.querySelector<HTMLDetailsElement>("[data-inspector]")!;
    expect(inspector.tagName).toBe("DETAILS");
    expect(inspector.open).toBe(false);
    expect(inspector.textContent).toContain("AgentDesk Inspector");
    // Nothing from the Inspector leaks into the default view.
    expect(view.container.querySelector("[data-event]")).toBeNull();
    expect(view.container.querySelector("[data-tool]")).toBeNull();
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

  it("changing the displayed objective text triggers nothing", async () => {
    const view = render(<App />);
    const prompt = view.getByRole("region", { name: "Objective" }).querySelector("blockquote, pre, p")!;
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

  it("the client's first turn opens the authorization overlay: objective, four operations with launch marked consequential, expected changes, two controls", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    expect(planId).toBe("PLAN-1");
    expect(getState()).toEqual(seed());
    const overlay = view.getByRole("alertdialog", { name: "Mission authorization required" });
    expect(overlay.textContent).toContain("MISSION AUTHORIZATION REQUIRED");
    expect(overlay.querySelector("[data-objective]")?.textContent).toBe(rescue.getPlan(planId)?.summary);
    const ops = [...within(overlay).getByRole("list", { name: "Operations in order" }).children].map((li) => li.textContent);
    expect(ops).toHaveLength(4);
    expect(ops[0]).toContain("Reserve two oxygen packs");
    expect(ops[1]).toContain("Assign rescue drone NIA-7");
    expect(ops[2]).toContain("Reroute power to Dock 3");
    expect(ops[3]).toContain("Launch the rescue");
    expect(ops[3]).toMatch(/consequential/i);
    expect(ops.slice(0, 3).join(" ")).not.toMatch(/consequential/i);
    // Capability names stay inside the Inspector, not in the plan a person reads.
    expect(overlay.textContent).not.toContain("reserve_oxygen");
    expect(overlay.textContent).not.toContain("launch_rescue");
    const changes = [...within(overlay).getByRole("list", { name: "Expected changes" }).children].map((li) => li.textContent);
    expect(changes).toEqual([
      "Oxygen packs available6→4",
      "Drone NIA-7standby→assigned",
      "Dock 3 power20%→65%",
      "Mission AST-10428draft→launched",
    ]);
    expect(within(overlay).getByRole("button", { name: "Reject mission" })).toBeDefined();
    expect(within(overlay).getByRole("button", { name: "Authorize rescue" })).toBeDefined();
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toBe("Agent connected");
  });

  it("authorization alone collapses the overlay and leaves the plan APPROVED with the mission unchanged; a bare actor cannot approve", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    expect(rescue.approvePlan(planId, OPERATOR).ok).toBe(false);
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
    await settle();
    expect(rescue.getPlan(planId)?.status).toBe("APPROVED");
    expect(getState()).toEqual(seed());
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(view.queryByRole("region", { name: "Rescue launched" })).toBeNull();
    expect(view.container.querySelector("[data-plan-status]")?.textContent).toMatch(/PLAN-1 authorized/);
    expect(view.queryByRole("button", { name: "Authorize rescue" })).toBeNull();
  });

  it("only the client's commit_plan changes the mission; the page then shows the compact confirmation with the receipt behind View evidence", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
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
    expect(getState().mission.status).toBe("launched");

    const confirmation = view.getByRole("region", { name: "Rescue launched" });
    expect(confirmation.textContent).toContain("RESCUE LAUNCHED");
    expect(confirmation.textContent).toContain("NIA-7 is en route to Asteria");
    expect(confirmation.textContent).toContain("4 operations completed");
    expect(confirmation.textContent).toContain("4 outcomes verified");
    expect(confirmation.textContent).toContain("Receipt PLAN-1");
    const evidence = confirmation.querySelector<HTMLDetailsElement>("[data-evidence]")!;
    expect(evidence.open).toBe(false);
    expect(within(evidence).getByText("View evidence")).toBeDefined();
    await act(async () => {
      fireEvent.click(within(evidence).getByText("View evidence"));
    });
    const lines = [...within(evidence).getByRole("list", { name: "Verified changes" }).children].map((li) => li.textContent);
    expect(lines).toEqual([
      "Oxygen packs available6→4verified",
      "Drone NIA-7standby→assignedverified",
      "Dock 3 power20%→65%verified",
      "Mission AST-10428draft→launchedverified",
    ]);
    expect(evidence.textContent).toContain("reserve_oxygen");
    // Guided attention moved across the four scene parts in order.
    expect([...revealedPanels()].slice(-4)).toEqual(["panel-oxygen", "panel-drone", "panel-dock", "panel-mission"]);
  });

  it("the Inspector holds the tools, the routing decision, the audit, and the receipts", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
    await act(async () => {
      await secondTurn(rescue, planId);
    });
    await settle(60);
    const inspector = view.container.querySelector<HTMLDetailsElement>("[data-inspector]")!;
    expect(inspector.open).toBe(false);
    await act(async () => {
      fireEvent.click(inspector.querySelector("summary")!);
    });
    expect(inspector.open).toBe(true);
    expect(inspector.querySelectorAll("[data-tool]").length).toBe(rescue.getSnapshot().nativeTools.length);
    expect(inspector.querySelectorAll("[data-match]").length).toBe(6);
    expect(inspector.querySelector('[data-event="capability_routed"]')).not.toBeNull();
    expect(inspector.querySelector('[data-event="plan_committed"]')).not.toBeNull();
    expect(inspector.querySelector(`[data-receipt="${planId}"]`)).not.toBeNull();
    expect(inspector.querySelector(`[data-plan="${planId}"]`)).not.toBeNull();
  });

  it("reset restores the seed and clears the plan, the confirmation, and the status", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
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
    expect(view.container.querySelector("[data-plan]")).toBeNull();
    expect(view.queryByRole("region", { name: "Rescue launched" })).toBeNull();
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toBe("Waiting for a WebMCP agent");
  });
});
