import { beforeEach, describe, expect, it } from "vitest";
import type { NativeToolDefinition, RegisterToolFn } from "@agentdesksdk/webmcp";
import { forkLedger } from "../src/adapter.ts";
import { RESCUE_PLAN, rescueCapabilities } from "../src/capabilities.ts";
import { createRescueRuntime, OPERATOR } from "../src/runtime.ts";
import { getState, reset, rows, seed } from "../src/state.ts";

const HERO =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

/** The model context a page would hand the runtime, the way the SDK's own tests mock it. */
function mockModelContext() {
  const tools = new Map<string, NativeToolDefinition>();
  const registerTool: RegisterToolFn = async (tool, options) => {
    tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      tools.delete(tool.name);
    });
  };
  return { tools, registerTool };
}

const EXPECTED_DIFF = [
  { field: "Oxygen packs available", before: 6, after: 4 },
  { field: "Drone NIA-7", before: "standby", after: "assigned" },
  { field: "Dock 3 power", before: "20%", after: "65%" },
  { field: "Mission AST-10428", before: "draft", after: "launched" },
];

const AFTER = {
  "Oxygen packs available": 4,
  "Drone NIA-7": "assigned",
  "Dock 3 power": "65%",
  "Mission AST-10428": "launched",
  "Crew Asteria": "stranded",
};

async function booted() {
  const model = mockModelContext();
  // The page requires a gesture; these tests approve as the runtime API, so the gesture is optional here.
  const runtime = createRescueRuntime({ registerTool: model.registerTool, approvalGesture: "optional" });
  await runtime.start();
  return { runtime, model };
}

describe("the rescue runtime", () => {
  beforeEach(() => {
    reset();
  });

  it("seeds exactly the stated world", () => {
    expect(getState()).toEqual({
      crew: { name: "Asteria", status: "stranded", location: "Dock 3" },
      oxygen: { available: 6, reserved: 0 },
      drone: { id: "NIA-7", status: "standby", assignment: null },
      dock: { name: "Dock 3", power: 20 },
      mission: { id: "AST-10428", status: "draft" },
    });
    expect(rows(getState())).toEqual({
      "Oxygen packs available": 6,
      "Drone NIA-7": "standby",
      "Dock 3 power": "20%",
      "Mission AST-10428": "draft",
      "Crew Asteria": "stranded",
    });
  });

  it("registers the bootstrap tools through registerTool, and find_capabilities routes the rescue tools for the hero prompt", async () => {
    const { runtime, model } = await booted();
    expect([...model.tools.keys()].sort()).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);
    expect(rescueCapabilities.map((c) => c.name)).toEqual([
      "find_stranded_crew",
      "inspect_rescue_conditions",
      "reserve_oxygen",
      "assign_rescue_drone",
      "reroute_dock_power",
      "launch_rescue",
      "complete_rescue",
    ]);

    await runtime.routeTask(HERO);
    const routed = runtime.getSnapshot().lastRouting!;
    const names = routed.activated;
    // The runtime routes with a budget of six, so the one call carries
    // every rescue capability available before the launch; complete_rescue
    // is unavailable until launch_rescue has completed, so it is not activated.
    expect([...names].sort()).toEqual(
      rescueCapabilities
        .filter((c) => c.name !== "complete_rescue")
        .map((c) => c.name)
        .sort(),
    );
    for (const name of names) {
      expect(model.tools.has(name)).toBe(true);
    }
    expect(routed.matches.find((m) => m.name === "launch_rescue")?.requiresApproval).toBe(true);
  });

  it("the reads return enough to decide", async () => {
    const { runtime } = await booted();
    const crew = await runtime.invoke("find_stranded_crew", {});
    expect(JSON.parse(crew.content[0]!.text)).toEqual({
      crews: [{ name: "Asteria", status: "stranded", location: "Dock 3", mission: "AST-10428", mission_status: "draft" }],
    });
    const conditions = JSON.parse((await runtime.invoke("inspect_rescue_conditions", {})).content[0]!.text);
    expect(conditions.oxygen).toEqual({ available: 6, reserved: 0 });
    expect(conditions.drone).toEqual({ id: "NIA-7", status: "standby", assignment: null });
    expect(conditions.dock).toEqual({ name: "Dock 3", power: 20 });
    expect(conditions.launch_requires).toEqual({ oxygen_reserved: 2, drone_assigned_to: "AST-10428", dock_power_at_least: 60 });
  });

  it("prepares one four-operation plan with the consolidated diff, and changes no live state", async () => {
    const { runtime } = await booted();
    const plan = await runtime.prepare({ operations: RESCUE_PLAN });
    expect(plan.status).toBe("DRAFT");
    expect(plan.risk).toBe("CONSEQUENTIAL");
    expect(plan.operations.map((o) => o.capability)).toEqual([
      "reserve_oxygen",
      "assign_rescue_drone",
      "reroute_dock_power",
      "launch_rescue",
    ]);
    expect(plan.operations.flatMap((o) => o.preview)).toEqual(EXPECTED_DIFF);
    expect(getState()).toEqual(seed());
  });

  it("one approval commits every operation once, the receipt matches the final state, and a second commit applies nothing", async () => {
    const { runtime } = await booted();
    const plan = await runtime.prepare({ operations: RESCUE_PLAN });
    expect(runtime.approvePlan(plan.id, OPERATOR).ok).toBe(true);
    const committed = await runtime.commitPlan(plan.id);
    expect(committed.ok, JSON.stringify(committed)).toBe(true);

    expect(rows(getState())).toEqual(AFTER);
    expect(getState().oxygen).toEqual({ available: 4, reserved: 2 });
    expect(getState().drone).toEqual({ id: "NIA-7", status: "assigned", assignment: "AST-10428" });
    expect(getState().dock.power).toBe(65);
    expect(getState().mission.status).toBe("launched");

    const settled = runtime.getPlan(plan.id)!;
    expect(settled.status).toBe("COMMITTED");
    expect(settled.outcomes?.map((o) => o.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(settled.outcomes?.map((o) => o.verification.status)).toEqual(["VERIFIED", "VERIFIED", "VERIFIED", "VERIFIED"]);

    const receipts = runtime.queryReceipts({ planId: plan.id });
    expect(receipts).toHaveLength(4);
    expect(receipts.flatMap((r) => r.receipt.changes).sort((a, b) => a.field.localeCompare(b.field))).toEqual(
      [...EXPECTED_DIFF].sort((a, b) => a.field.localeCompare(b.field)),
    );
    expect(receipts.every((r) => r.verification.status === "VERIFIED")).toBe(true);
    // Every fork the runtime opened, at prepare or at commit, was released or landed.
    const ledger = forkLedger();
    expect(ledger.open, JSON.stringify(ledger)).toBe(0);

    const again = await runtime.commitPlan(plan.id);
    expect(again.ok).toBe(false);
    expect(rows(getState())).toEqual(AFTER);
  });

  it("reject leaves every value unchanged and releases the forks", async () => {
    const { runtime } = await booted();
    const plan = await runtime.prepare({ operations: RESCUE_PLAN });
    expect(forkLedger().open).toBeGreaterThan(0);
    expect(runtime.rejectPlan(plan.id).ok).toBe(true);
    expect(getState()).toEqual(seed());
    expect(forkLedger(), JSON.stringify(forkLedger())).toMatchObject({ open: 0 });
    expect((await runtime.commitPlan(plan.id)).ok).toBe(false);
    expect(getState()).toEqual(seed());
  });

  it("a launch that is not ready refuses at prepare rather than failing halfway", async () => {
    const { runtime } = await booted();
    await expect(runtime.prepare({ operations: [{ capability: "launch_rescue", input: {} }] })).rejects.toThrow(
      /needs 2 oxygen packs reserved/,
    );
    expect(getState()).toEqual(seed());
    expect(forkLedger(), JSON.stringify(forkLedger())).toMatchObject({ open: 0 });
  });

  it("reset restores the exact seed after a launch", async () => {
    const { runtime } = await booted();
    const plan = await runtime.prepare({ operations: RESCUE_PLAN });
    runtime.approvePlan(plan.id, OPERATOR);
    await runtime.commitPlan(plan.id);
    expect(getState().mission.status).toBe("launched");
    reset();
    await runtime.reset();
    expect(getState()).toEqual(seed());
    expect(runtime.listPlans()).toEqual([]);
    expect(runtime.queryReceipts()).toEqual([]);
  });
});
