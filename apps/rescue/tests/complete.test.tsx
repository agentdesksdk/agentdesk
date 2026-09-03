// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import type { AgentDeskRuntime, ToolResult } from "@agentdesksdk/webmcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, COMPLETE_PROMPT } from "../src/App.tsx";
import { COMPLETE_RESCUE, rescueCapabilities } from "../src/capabilities.ts";
import { setGuidedPace } from "../src/Presence.tsx";
import { createRescueRuntime, OPERATOR, rescue, resetRescue } from "../src/runtime.ts";
import { getState, reset, rows, seed } from "../src/state.ts";
import { firstTurn, HERO_PROMPT, mockModelContext, payload, secondTurn } from "./fixtures/external-client.ts";

const LAUNCHED = {
  "Oxygen packs available": 4,
  "Drone NIA-7": "assigned",
  "Dock 3 power": "65%",
  "Mission AST-10428": "launched",
  "Crew Asteria": "stranded",
};

const COMPLETED = { ...LAUNCHED, "Mission AST-10428": "completed", "Crew Asteria": "rescued" };

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

/** The client's third turn: route the completion prompt, then complete the rescue with an idempotency key. */
async function thirdTurn(runtime: AgentDeskRuntime, key = "complete-1") {
  const routed = payload(await runtime.invoke("find_capabilities", { query: COMPLETE_PROMPT }));
  const completed = await runtime.invoke("invoke_capability", { name: COMPLETE_RESCUE, input: { mission: "AST-10428" }, idempotency_key: key });
  return { routed, completed };
}

/** The launch story, as the client and the person play it, against any rescue runtime. */
async function launched(runtime: AgentDeskRuntime, approve: (planId: string) => Promise<void> | void) {
  const { planId } = await firstTurn(runtime, HERO_PROMPT);
  await approve(planId!);
  const second = await secondTurn(runtime, planId!);
  expect(second.committed.status).toBe("COMMITTED");
  return planId!;
}

describe("complete_rescue is a post-launch capability the runtime governs", () => {
  beforeEach(() => {
    reset();
  });

  async function booted() {
    const model = mockModelContext();
    const runtime = createRescueRuntime({ registerTool: model.registerTool, approvalGesture: "optional" });
    await runtime.start();
    return { runtime, model };
  }

  it("is declared seventh, staged, and writes both the crew and the mission", () => {
    const capability = rescueCapabilities.find((c) => c.name === COMPLETE_RESCUE)!;
    expect(capability).toBeDefined();
    expect(capability.risk).toBe("WRITE");
    expect(rows(seed())).toHaveProperty("Crew Asteria", "stranded");
  });

  it("before launch it is ranked but unavailable with a reason, not activated, not registered, and refuses to run", async () => {
    const { runtime, model } = await booted();
    const routed = payload(await runtime.invoke("find_capabilities", { query: COMPLETE_PROMPT }));
    const match = (routed.matches as Array<{ name: string; available: boolean; reasonCode?: string; reason?: string }>).find(
      (m) => m.name === COMPLETE_RESCUE,
    );
    expect(match).toBeDefined();
    expect(match!.available).toBe(false);
    expect(match!.reasonCode).toBe("NOT_LAUNCHED");
    expect(match!.reason).toMatch(/launch/i);
    expect(routed.activated_tools as string[]).not.toContain(COMPLETE_RESCUE);
    expect(model.tools.has(COMPLETE_RESCUE)).toBe(false);
    expect(runtime.getSnapshot().available).not.toContain(COMPLETE_RESCUE);

    const refused: ToolResult = await runtime.invoke("invoke_capability", { name: COMPLETE_RESCUE, input: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("NOT_LAUNCHED");
    expect(getState()).toEqual(seed());
    expect(runtime.getSnapshot().audit.filter((e) => e.kind === "execution_completed")).toEqual([]);
  });

  it("the four-step plan is unchanged by it: the hero prompt still routes the six, and the plan still ends at launched", async () => {
    const { runtime, model } = await booted();
    await launched(runtime, (planId) => {
      expect(runtime.approvePlan(planId, OPERATOR).ok).toBe(true);
    });
    const routing = runtime.getSnapshot().lastRouting!;
    expect([...routing.activated].sort()).toEqual([
      "assign_rescue_drone",
      "find_stranded_crew",
      "inspect_rescue_conditions",
      "launch_rescue",
      "reroute_dock_power",
      "reserve_oxygen",
    ]);
    expect(model.tools.has(COMPLETE_RESCUE)).toBe(false);
    expect(rows(getState())).toEqual(LAUNCHED);
    expect(runtime.getPlan("PLAN-1")!.operations.map((o) => o.capability)).not.toContain(COMPLETE_RESCUE);
  });

  it("after launch it routes and registers; the crew and mission change only when it completes, with a receipt covering both verified changes", async () => {
    const { runtime, model } = await booted();
    await launched(runtime, (planId) => {
      runtime.approvePlan(planId, OPERATOR);
    });
    expect(rows(getState())).toEqual(LAUNCHED);

    const routed = payload(await runtime.invoke("find_capabilities", { query: COMPLETE_PROMPT }));
    const match = (routed.matches as Array<{ name: string; available: boolean }>).find((m) => m.name === COMPLETE_RESCUE);
    expect(match?.available).toBe(true);
    expect(routed.activated_tools as string[]).toContain(COMPLETE_RESCUE);
    expect(model.tools.has(COMPLETE_RESCUE)).toBe(true);
    // Routing and registration changed nothing.
    expect(rows(getState())).toEqual(LAUNCHED);

    const completed: ToolResult = await runtime.invoke("invoke_capability", {
      name: COMPLETE_RESCUE,
      input: { mission: "AST-10428" },
      idempotency_key: "complete-1",
    });
    expect(completed.isError).toBeFalsy();
    expect(payload(completed)).toMatchObject({ status: "COMPLETED" });
    expect(rows(getState())).toEqual(COMPLETED);
    expect(getState().crew.status).toBe("rescued");
    expect(getState().mission.status).toBe("completed");

    const receipts = payload(await runtime.invoke("invoke_capability", { name: "query_receipts", input: { capability: COMPLETE_RESCUE } }));
    const list = receipts.receipts as Array<{ verification: { status: string }; receipt: { changes: Array<{ field: string; before: unknown; after: unknown }> } }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.verification.status).toBe("VERIFIED");
    expect(list[0]!.receipt.changes).toEqual([
      { field: "Mission AST-10428", before: "launched", after: "completed" },
      { field: "Crew Asteria", before: "stranded", after: "rescued" },
    ]);
  });

  it("a wrong mission is refused UNKNOWN_MISSION before any staged mutation: the mission stays launched, the crew stranded, no receipt, no completion event", async () => {
    const { runtime } = await booted();
    await launched(runtime, (planId) => {
      runtime.approvePlan(planId, OPERATOR);
    });
    const wrong: ToolResult = await runtime.invoke("invoke_capability", {
      name: COMPLETE_RESCUE,
      input: { mission: "WRONG-MISSION" },
      idempotency_key: "wrong-1",
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]?.text).toContain("UNKNOWN_MISSION");
    expect(rows(getState())).toEqual(LAUNCHED);
    expect(getState().mission.status).toBe("launched");
    expect(getState().crew.status).toBe("stranded");
    const receipts = payload(await runtime.invoke("invoke_capability", { name: "query_receipts", input: { capability: COMPLETE_RESCUE } }));
    expect(receipts.receipts).toEqual([]);
    expect(runtime.getSnapshot().audit.filter((e) => e.kind === "execution_completed" && e.capability === COMPLETE_RESCUE)).toEqual([]);
    expect(runtime.getSnapshot().audit.filter((e) => e.kind === "execution_failed" && e.capability === COMPLETE_RESCUE)).toEqual([]);
  });

  it("a missing mission argument defaults to AST-10428, as launch_rescue does", async () => {
    const { runtime } = await booted();
    await launched(runtime, (planId) => {
      runtime.approvePlan(planId, OPERATOR);
    });
    const completed: ToolResult = await runtime.invoke("invoke_capability", { name: COMPLETE_RESCUE, input: {}, idempotency_key: "default-1" });
    expect(completed.isError).toBeFalsy();
    expect(payload(completed)).toMatchObject({ status: "COMPLETED" });
    expect(rows(getState())).toEqual(COMPLETED);
  });

  it("a replay with the same idempotency key returns the recorded result and does not complete twice; a fresh key after completion is refused", async () => {
    const { runtime } = await booted();
    await launched(runtime, (planId) => {
      runtime.approvePlan(planId, OPERATOR);
    });
    const first = (await thirdTurn(runtime, "complete-1")).completed;
    expect(first.isError).toBeFalsy();
    const executions = () => runtime.getSnapshot().audit.filter((e) => e.kind === "execution_completed" && e.capability === COMPLETE_RESCUE);
    expect(executions()).toHaveLength(1);

    const again = (await thirdTurn(runtime, "complete-1")).completed;
    expect(again).toEqual(first);
    expect(executions()).toHaveLength(1);
    expect(rows(getState())).toEqual(COMPLETED);

    const fresh: ToolResult = await runtime.invoke("invoke_capability", { name: COMPLETE_RESCUE, input: {}, idempotency_key: "complete-2" });
    expect(fresh.isError).toBe(true);
    expect(fresh.content[0]?.text).toContain("ALREADY_COMPLETED");
    expect(executions()).toHaveLength(1);
    expect(rows(getState())).toEqual(COMPLETED);
  });
});

/** What the scene says about the crew and the mission, read off its markup. */
function crewReads(view: RenderResult) {
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return {
    beacon: q("[data-beacon]")?.getAttribute("data-beacon"),
    crew: q("[data-crew-status]")?.textContent,
    mission: q("[data-mission-status]")?.textContent,
    droneUnderway: q('[data-scene="drone"]')?.getAttribute("data-underway"),
    sceneUnderway: q(".scene")?.getAttribute("data-underway"),
    droneLabel: q("[data-drone-label]")?.textContent,
    route: q('[data-scene="route"]') !== null,
    completed: q(".scene")?.getAttribute("data-completed"),
  };
}

// The launch frame: the route drawn, the drone labelled with its assignment, under way.
const UNDERWAY = {
  beacon: "distress",
  crew: "STRANDED · no power",
  mission: "Rescue underway",
  droneUnderway: "true",
  sceneUnderway: "true",
  droneLabel: "Assigned AST-10428",
  route: true,
  completed: "false",
};
// The completion frame: the route hidden, the drone no longer under way, the crew aboard.
const RECOVERED = {
  beacon: "stopped",
  crew: "RESCUED · crew safe",
  mission: "MISSION COMPLETE",
  droneUnderway: "false",
  sceneUnderway: "false",
  droneLabel: "Crew aboard",
  route: false,
  completed: "true",
};

describe("the page shows the completion only when the runtime says complete_rescue landed, and never invokes it", () => {
  beforeEach(async () => {
    await resetRescue();
    setGuidedPace(5);
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(cleanup);

  async function launchOnPage(view: RenderResult) {
    let planId = "";
    await act(async () => {
      planId = (await firstTurn(rescue, HERO_PROMPT)).planId!;
    });
    await settle();
    await clickWithActivation(view.getByRole("button", { name: "Authorize rescue" }));
    await act(async () => {
      await secondTurn(rescue, planId);
    });
    await settle(60);
    return planId;
  }

  it("shows the second objective only after the launch, and the stranded crew until the capability completes", async () => {
    const view = render(<App />);
    expect(view.queryByRole("region", { name: "Next objective" })).toBeNull();
    expect(crewReads(view)).toEqual({ ...UNDERWAY, mission: "Awaiting rescue", droneUnderway: "false", sceneUnderway: "false", droneLabel: "Standby", route: false });

    await launchOnPage(view);
    expect(crewReads(view)).toEqual(UNDERWAY);
    const next = view.getByRole("region", { name: "Next objective" });
    expect(next.textContent).toContain(COMPLETE_PROMPT);
    expect(within(next).getByRole("button", { name: /copy/i })).toBeDefined();
    expect(view.queryByRole("region", { name: "Crew recovered" })).toBeNull();
  });

  it("clicking every control after the launch invokes nothing and leaves the crew stranded", async () => {
    const view = render(<App />);
    await launchOnPage(view);
    const executions = () => rescue.getSnapshot().audit.filter((e) => e.kind === "execution_completed" && e.capability === COMPLETE_RESCUE);
    const invocations = () => rescue.getSnapshot().audit.filter((e) => e.kind === "capability_invoked" && e.capability === COMPLETE_RESCUE);
    for (const button of [...view.container.querySelectorAll("button")]) {
      await clickWithActivation(button as HTMLElement);
    }
    for (const summary of [...view.container.querySelectorAll("details > summary")]) {
      await act(async () => {
        fireEvent.click(summary);
      });
    }
    await settle(60);
    expect(executions()).toEqual([]);
    expect(invocations()).toEqual([]);
    // Reset is among the controls; either the launched or the seeded world is acceptable, but never a rescued crew.
    expect(getState().crew.status).toBe("stranded");
    expect(getState().mission.status).not.toBe("completed");
  });

  it("the capability's completion event produces the final scene and the CREW RECOVERED confirmation with the receipt behind View evidence", async () => {
    const view = render(<App />);
    await launchOnPage(view);
    expect(crewReads(view)).toEqual(UNDERWAY);

    // Routing the completion prompt changes nothing in the scene.
    await act(async () => {
      await rescue.invoke("find_capabilities", { query: COMPLETE_PROMPT });
    });
    await settle();
    expect(crewReads(view)).toEqual(UNDERWAY);

    let completed: ToolResult | undefined;
    await act(async () => {
      completed = (await thirdTurn(rescue, "complete-1")).completed;
    });
    await settle(60);
    expect(completed?.isError).toBeFalsy();
    expect(crewReads(view)).toEqual(RECOVERED);

    const confirmation = view.getByRole("region", { name: "Crew recovered" });
    expect(confirmation.textContent).toContain("CREW RECOVERED");
    expect(confirmation.textContent).toContain("Asteria");
    expect(confirmation.textContent).toContain("Mission AST-10428 complete");
    const evidence = confirmation.querySelector<HTMLDetailsElement>("[data-evidence]")!;
    expect(evidence.open).toBe(false);
    await act(async () => {
      fireEvent.click(within(evidence).getByText("View evidence"));
    });
    const lines = [...within(evidence).getByRole("list", { name: "Changes read back" }).children].map((li) => li.textContent);
    expect(lines).toEqual(["Mission AST-10428launched→completedmatches", "Crew Asteriastranded→rescuedmatches"]);
    expect(evidence.textContent).toContain(COMPLETE_RESCUE);
    // The launch confirmation stays as the record of the earlier plan.
    expect(view.getByRole("region", { name: "Rescue launched" })).toBeDefined();
  });

  it("reset restores the stranded scene", async () => {
    const view = render(<App />);
    await launchOnPage(view);
    await act(async () => {
      await thirdTurn(rescue, "complete-1");
    });
    await settle(60);
    expect(crewReads(view)).toEqual(RECOVERED);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset" }));
    });
    await settle(60);
    expect(getState()).toEqual(seed());
    expect(crewReads(view)).toEqual({ ...UNDERWAY, mission: "Awaiting rescue", droneUnderway: "false", sceneUnderway: "false", droneLabel: "Standby", route: false });
    expect(view.queryByRole("region", { name: "Crew recovered" })).toBeNull();
    expect(view.queryByRole("region", { name: "Next objective" })).toBeNull();
  });
});
