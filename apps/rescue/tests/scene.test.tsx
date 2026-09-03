// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import type { PresentationEvent, PresentationListener } from "@agentdesksdk/webmcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { setGuidedPace } from "../src/Presence.tsx";
import { rescue, resetRescue } from "../src/runtime.ts";
import { createSceneStore, type SceneFlags } from "../src/scene.ts";
import { getState, seed } from "../src/state.ts";
import { firstTurn, HERO_PROMPT, secondTurn } from "./fixtures/external-client.ts";

const NOTHING: SceneFlags = { oxygenLoaded: false, droneAssigned: false, dockPowered: false, underway: false };

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

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

async function agentFirstTurn() {
  let planId: string | undefined;
  await act(async () => {
    planId = (await firstTurn(rescue, HERO_PROMPT)).planId;
  });
  await settle();
  return planId!;
}

/** What the scene shows, read off its markup: every state is an attribute or text, never a colour. */
function sceneReads(view: RenderResult) {
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return {
    oxygenLoaded: q('[data-scene="oxygen"]')?.getAttribute("data-loaded"),
    oxygenCount: q("[data-oxygen-count]")?.textContent,
    droneAssigned: q('[data-scene="drone"]')?.getAttribute("data-assigned"),
    droneUnderway: q('[data-scene="drone"]')?.getAttribute("data-underway"),
    droneLabel: q("[data-drone-label]")?.textContent,
    route: q('[data-scene="route"]') !== null,
    dockPowered: q('[data-scene="dock"]')?.getAttribute("data-powered"),
    dockPower: q("[data-dock-power]")?.textContent,
    mission: q("[data-mission-status]")?.textContent,
  };
}

const BEFORE = {
  oxygenLoaded: "false",
  oxygenCount: "6",
  droneAssigned: "false",
  droneUnderway: "false",
  droneLabel: "Standby",
  route: false,
  dockPowered: "false",
  dockPower: "20%",
  mission: "Awaiting rescue",
};

const AFTER = {
  oxygenLoaded: "true",
  oxygenCount: "4",
  droneAssigned: "true",
  droneUnderway: "true",
  droneLabel: "Assigned AST-10428",
  route: true,
  dockPowered: "true",
  dockPower: "65%",
  mission: "Rescue underway",
};

describe("the scene store advances only on the runtime's completion event for each operation", () => {
  function harness() {
    let listener: PresentationListener = () => {};
    const store = createSceneStore((next) => {
      listener = next;
      return () => {};
    });
    const emit = (event: Partial<PresentationEvent> & { capability: string; phase: PresentationEvent["phase"] }) =>
      listener({ at: 0, ...event });
    return { store, emit };
  }

  it("starts with nothing lit", () => {
    expect(harness().store.get()).toEqual(NOTHING);
  });

  it.each([
    ["reserve_oxygen", "oxygenLoaded"],
    ["assign_rescue_drone", "droneAssigned"],
    ["reroute_dock_power", "dockPowered"],
    ["launch_rescue", "underway"],
  ] as const)("%s: started does nothing, a replay without an executionId does nothing, completion lights %s", (capability, flag) => {
    const { store, emit } = harness();
    emit({ phase: "capability_started", capability, executionId: "exec-1" });
    expect(store.get()).toEqual(NOTHING);
    emit({ phase: "capability_completed", capability });
    expect(store.get()).toEqual(NOTHING);
    emit({ phase: "capability_completed", capability, executionId: "exec-1" });
    expect(store.get()).toEqual({ ...NOTHING, [flag]: true });
  });

  it("a completion for a read lights nothing, and clear puts everything out", () => {
    const { store, emit } = harness();
    emit({ phase: "capability_completed", capability: "find_stranded_crew", executionId: "exec-1" });
    expect(store.get()).toEqual(NOTHING);
    emit({ phase: "capability_completed", capability: "launch_rescue", executionId: "exec-2" });
    expect(store.get().underway).toBe(true);
    store.clear();
    expect(store.get()).toEqual(NOTHING);
  });
});

describe("the scene is bound to the runtime: nothing in it moves before the runtime says an operation landed", () => {
  beforeEach(async () => {
    await resetRescue();
    setGuidedPace(5);
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(cleanup);

  it("shows the stranded ship, the drone on standby, the unpowered dock, and six oxygen canisters from the seed", () => {
    const view = render(<App />);
    expect(sceneReads(view)).toEqual(BEFORE);
    expect(view.container.querySelectorAll("[data-canister]").length).toBe(6);
    expect(view.container.querySelectorAll('[data-canister][data-lit="true"]').length).toBe(0);
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toBe("Waiting for a WebMCP agent");
  });

  it("a staged plan and its authorization change nothing in the scene; every binding lights after the commit lands", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    expect(sceneReads(view)).toEqual(BEFORE);
    expect(view.container.querySelector("[data-agent-status]")?.textContent).toBe("Agent connected");

    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
    await settle();
    expect(rescue.getPlan(planId)?.status).toBe("APPROVED");
    expect(sceneReads(view)).toEqual(BEFORE);
    expect(getState()).toEqual(seed());

    await act(async () => {
      await secondTurn(rescue, planId);
    });
    await settle(120);
    expect(rescue.getPlan(planId)?.status).toBe("COMMITTED");
    expect(sceneReads(view)).toEqual(AFTER);
    expect(view.container.querySelectorAll('[data-canister][data-lit="true"]').length).toBe(2);
  });

  it("a rejected plan changes nothing in the scene or the mission", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reject mission" }));
    });
    await settle();
    expect(rescue.getPlan(planId)?.status).toBe("REJECTED");
    expect(sceneReads(view)).toEqual(BEFORE);
    expect(getState()).toEqual(seed());
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(view.container.querySelector("[data-plan-status]")?.textContent).toContain("rejected");
  });

  it("reset puts the scene back to the seed", async () => {
    const view = render(<App />);
    const planId = await agentFirstTurn();
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
    await act(async () => {
      await secondTurn(rescue, planId);
    });
    await settle(60);
    expect(sceneReads(view)).toEqual(AFTER);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset" }));
    });
    await settle(60);
    expect(sceneReads(view)).toEqual(BEFORE);
    expect(within(view.container).queryByRole("region", { name: "Rescue launched" })).toBeNull();
  });
});
