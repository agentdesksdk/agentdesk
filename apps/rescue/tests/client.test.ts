import { beforeEach, describe, expect, it } from "vitest";
import type { NativeToolDefinition, RegisterToolFn } from "@agentdesksdk/webmcp";
import { armCommitFault, forkLedger } from "../src/adapter.ts";
import { clearClientCalls, getClientCalls, HERO_PROMPT, runHeroPrompt } from "../src/client.ts";
import { createRescueRuntime, OPERATOR } from "../src/runtime.ts";
import { getState, reset, rows, seed } from "../src/state.ts";

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

async function booted() {
  const model = mockModelContext();
  const runtime = createRescueRuntime({ registerTool: model.registerTool, approvalGesture: "optional" });
  await runtime.start();
  return { runtime, model };
}

/** Approves the plan the moment the client stages it, the way the card would. */
function approveWhenStaged(runtime: Awaited<ReturnType<typeof booted>>["runtime"]) {
  let done = false;
  runtime.subscribe(() => {
    const draft = runtime.listPlans().find((plan) => plan.status === "DRAFT");
    if (draft && !done) {
      done = true;
      runtime.approvePlan(draft.id, OPERATOR);
    }
  });
}

function rejectWhenStaged(runtime: Awaited<ReturnType<typeof booted>>["runtime"]) {
  let done = false;
  runtime.subscribe(() => {
    const draft = runtime.listPlans().find((plan) => plan.status === "DRAFT");
    if (draft && !done) {
      done = true;
      runtime.rejectPlan(draft.id);
    }
  });
}

describe("the agent's proposal is the sequence of tool calls a client makes", () => {
  beforeEach(() => {
    reset();
    clearClientCalls();
  });

  it("routes, reads, stages through prepare_plan, waits for the person, commits through commit_plan, and reads the receipts back", async () => {
    const { runtime, model } = await booted();
    approveWhenStaged(runtime);

    const outcome = await runHeroPrompt(runtime, HERO_PROMPT);

    expect(outcome.kind).toBe("committed");
    const calls = getClientCalls().map((call) => call.name ?? call.tool);
    expect(calls).toEqual([
      "find_capabilities",
      "find_stranded_crew",
      "inspect_rescue_conditions",
      "prepare_plan",
      "commit_plan",
      "query_receipts",
    ]);
    expect(getClientCalls().every((call) => call.status === "ok")).toBe(true);
    // The plan came through the governance gateway, not a page-private call.
    const audit = runtime.getSnapshot().audit;
    expect(audit.some((event) => event.kind === "plan_prepared")).toBe(true);
    expect(audit.filter((event) => event.kind === "plan_approved")).toHaveLength(1);
    const writes = ["reserve_oxygen", "assign_rescue_drone", "reroute_dock_power", "launch_rescue"];
    expect(
      audit.flatMap((event) => (event.kind === "execution_completed" && writes.includes(event.capability) ? [event.capability] : [])),
    ).toEqual(writes);
    // The five routed tools reached the surface; the sixth is still reachable by name.
    for (const name of ["find_stranded_crew", "reserve_oxygen", "assign_rescue_drone", "reroute_dock_power", "launch_rescue"]) {
      expect(model.tools.has(name), name).toBe(true);
    }
    expect(rows(getState())).toEqual({
      "Oxygen packs available": 4,
      "Drone NIA-7": "assigned",
      "Dock 3 power": "65%",
      "Mission AST-10428": "launched",
    });
    expect(runtime.listPlans()[0]?.status).toBe("COMMITTED");
    expect(forkLedger().open).toBe(0);
  });

  it("stops when the person rejects, with nothing run and nothing changed", async () => {
    const { runtime } = await booted();
    rejectWhenStaged(runtime);
    const outcome = await runHeroPrompt(runtime, HERO_PROMPT);
    expect(outcome.kind).toBe("rejected");
    expect(getClientCalls().map((call) => call.name ?? call.tool)).toEqual([
      "find_capabilities",
      "find_stranded_crew",
      "inspect_rescue_conditions",
      "prepare_plan",
      runtime.listPlans()[0]!.id,
    ]);
    expect(getState()).toEqual(seed());
    expect(runtime.listPlans()[0]?.status).toBe("REJECTED");
  });

  it("a failed operation stops the plan; the operations after it do not run and the state shows only what landed", async () => {
    const { runtime } = await booted();
    approveWhenStaged(runtime);
    armCommitFault("reroute_dock_power");

    const outcome = await runHeroPrompt(runtime, HERO_PROMPT);

    expect(outcome.kind).toBe("refused");
    const plan = runtime.listPlans()[0]!;
    expect(plan.status).not.toBe("COMMITTED");
    const statuses = plan.outcomes?.map((o) => o.status) ?? [];
    expect(statuses.slice(0, 2)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(statuses[2]).not.toBe("COMPLETED");
    expect(statuses.length < 4 || statuses[3] !== "COMPLETED").toBe(true);
    // Oxygen and the drone landed; the dock and the launch did not.
    expect(getState().oxygen).toEqual({ available: 4, reserved: 2 });
    expect(getState().drone.status).toBe("assigned");
    expect(getState().dock.power).toBe(20);
    expect(getState().mission.status).toBe("draft");
    // And nothing is silently continued: a second commit is refused.
    expect((await runtime.commitPlan(plan.id)).ok).toBe(false);
    expect(getState().mission.status).toBe("draft");
  });

  it("approving twice or committing twice applies nothing twice", async () => {
    const { runtime } = await booted();
    approveWhenStaged(runtime);
    await runHeroPrompt(runtime, HERO_PROMPT);
    const plan = runtime.listPlans()[0]!;
    expect(runtime.approvePlan(plan.id, OPERATOR).ok).toBe(false);
    expect((await runtime.commitPlan(plan.id)).ok).toBe(false);
    expect(runtime.queryReceipts({ planId: plan.id })).toHaveLength(4);
    expect(getState().oxygen).toEqual({ available: 4, reserved: 2 });
  });
});
