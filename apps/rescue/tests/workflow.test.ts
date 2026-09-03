import { beforeEach, describe, expect, it } from "vitest";
import { forkLedger } from "../src/adapter.ts";
import { rescueCapabilities } from "../src/capabilities.ts";
import { createRescueRuntime, OPERATOR } from "../src/runtime.ts";
import { getState, reset, rows, seed } from "../src/state.ts";
import { firstTurn, HERO_PROMPT, mockModelContext, secondTurn } from "./fixtures/external-client.ts";

const SIX = [
  "find_stranded_crew",
  "inspect_rescue_conditions",
  "reserve_oxygen",
  "assign_rescue_drone",
  "reroute_dock_power",
  "launch_rescue",
];

async function booted() {
  const model = mockModelContext();
  // The page's runtime requires a gesture; here approval is the runtime API's, so it is optional.
  const runtime = createRescueRuntime({ registerTool: model.registerTool, approvalGesture: "optional" });
  await runtime.start();
  return { runtime, model };
}

describe("an external client performs the rescue through the tools; the application only records and approves", () => {
  beforeEach(() => {
    reset();
  });

  it("declares six capabilities, the launch requiring the readiness read", () => {
    expect(rescueCapabilities.map((c) => c.name)).toEqual(SIX);
    const launch = rescueCapabilities.find((c) => c.name === "launch_rescue")!;
    expect(launch.relationships.requires).toContain("inspect_rescue_conditions");
  });

  it("find_capabilities on the hero prompt ranks every rescue capability, the readiness read pulled in by the launch", async () => {
    const { runtime } = await booted();
    const { routed } = await firstTurn(runtime, HERO_PROMPT);
    const matches = (routed.matches as Array<{ name: string }>).map((m) => m.name);
    for (const name of ["find_stranded_crew", "reserve_oxygen", "assign_rescue_drone", "reroute_dock_power", "launch_rescue"]) {
      expect(matches, name).toContain(name);
    }
    const report = runtime.getSnapshot().lastRouting!;
    expect(report.activated.length).toBeGreaterThanOrEqual(5);
  });

  it.fails(
    "all six land in one call: blocked by the runtime slicing ranked matches at DEFAULT_ROUTED (packages/webmcp/src/runtime.ts:3669 and :3681, 5 of MAX_ROUTED 6) with no limit input",
    async () => {
      const { runtime } = await booted();
      const { routed } = await firstTurn(runtime, HERO_PROMPT);
      const activated = routed.activated_tools as string[];
      for (const name of SIX) {
        expect(activated, name).toContain(name);
      }
    },
  );

  it("the first turn stages one plan through prepare_plan and changes no live state; a person approves; the next turn commits and reads four verified receipts", async () => {
    const { runtime, model } = await booted();
    expect([...model.tools.keys()].sort()).toEqual(["find_capabilities", "get_action_status", "get_context", "invoke_capability"]);

    const first = await firstTurn(runtime);
    expect(first.crew).toEqual({
      crews: [{ name: "Asteria", status: "stranded", location: "Dock 3", mission: "AST-10428", mission_status: "draft" }],
    });
    expect((first.conditions as { oxygen: unknown }).oxygen).toEqual({ available: 6, reserved: 0 });
    expect(first.planId).toBe("PLAN-1");
    expect(first.prepared.status).toBe("DRAFT");
    expect(getState()).toEqual(seed());
    // Every routed tool reached the mock surface.
    for (const name of runtime.getSnapshot().lastRouting!.activated) {
      expect(model.tools.has(name), name).toBe(true);
    }

    // Approval alone moves the plan and nothing else.
    expect(runtime.approvePlan("PLAN-1", OPERATOR).ok).toBe(true);
    expect(runtime.getPlan("PLAN-1")?.status).toBe("APPROVED");
    expect(getState()).toEqual(seed());

    const second = await secondTurn(runtime, "PLAN-1");
    expect(second.committed.ok).toBe(true);
    expect(second.committed.status).toBe("COMMITTED");
    const receipts = second.receipts.receipts as Array<{ verification: { status: string }; receipt: { changes: unknown[] } }>;
    expect(receipts).toHaveLength(4);
    expect(receipts.every((r) => r.verification.status === "VERIFIED")).toBe(true);
    expect(rows(getState())).toEqual({
      "Oxygen packs available": 4,
      "Drone NIA-7": "assigned",
      "Dock 3 power": "65%",
      "Mission AST-10428": "launched",
    });
    expect(forkLedger().open).toBe(0);
  });

  it("commit_plan without an approval is refused and changes nothing", async () => {
    const { runtime } = await booted();
    await firstTurn(runtime);
    const second = await secondTurn(runtime, "PLAN-1");
    expect(second.committed.ok).toBe(false);
    expect(getState()).toEqual(seed());
    expect(runtime.getPlan("PLAN-1")?.status).toBe("DRAFT");
  });

  it("an unrelated prompt stages nothing: only the client's prepare_plan stages a plan, and the runtime holds none until it is called", async () => {
    const { runtime } = await booted();
    await runtime.invoke("find_capabilities", { query: "Print the dock manifest for Tuesday." });
    expect(runtime.listPlans()).toEqual([]);
    expect(getState()).toEqual(seed());
  });

  it("reset restores the seed and forgets the plan and the receipts", async () => {
    const { runtime } = await booted();
    await firstTurn(runtime);
    runtime.approvePlan("PLAN-1", OPERATOR);
    await secondTurn(runtime, "PLAN-1");
    expect(getState().mission.status).toBe("launched");
    reset();
    await runtime.reset();
    expect(getState()).toEqual(seed());
    expect(runtime.listPlans()).toEqual([]);
    expect(runtime.queryReceipts()).toEqual([]);
  });
});
