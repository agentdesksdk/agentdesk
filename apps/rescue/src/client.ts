import type { AgentDeskRuntime, ToolResult } from "@agentdesksdk/webmcp";
import { RESCUE_PLAN } from "./capabilities.ts";
import { CREW, DOCK, DRONE, MISSION } from "./state.ts";

export const HERO_PROMPT =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

export const PLAN_SUMMARY = `Rescue the ${CREW} crew: reserve two oxygen packs, assign ${DRONE}, reroute power to ${DOCK}, launch ${MISSION}.`;

/** One tool call the client made, as the rail shows it. */
export type ClientCall = {
  tool: string;
  /** The governance operation or capability named through invoke_capability, when one was. */
  name?: string;
  status: "ok" | "refused" | "error";
  summary: string;
  at: number;
};

export type ClientOutcome =
  | { kind: "committed"; planId: string; receipts: number }
  | { kind: "rejected"; planId: string }
  | { kind: "refused"; step: string; reason: string };

const listeners = new Set<() => void>();
let calls: ClientCall[] = [];

export function getClientCalls(): ClientCall[] {
  return calls;
}

export function subscribeClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearClientCalls(): void {
  calls = [];
  for (const listener of listeners) {
    listener();
  }
}

function record(call: Omit<ClientCall, "at">): void {
  calls = [...calls, { ...call, at: Date.now() }];
  for (const listener of listeners) {
    listener();
  }
}

function payload(result: ToolResult): Record<string, unknown> {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function status(result: ToolResult): ClientCall["status"] {
  if (result.isError) {
    return "error";
  }
  return result.code === undefined ? "ok" : "refused";
}

/** Waits for the plan to leave DRAFT: a person approved or rejected it on the card. */
function decided(runtime: AgentDeskRuntime, planId: string): Promise<string> {
  return new Promise((resolve) => {
    // subscribe delivers the current snapshot at once, so the handle is
    // declared before the listener that may need it on that first call.
    let unsubscribe: () => void = () => {};
    let done = false;
    const check = () => {
      const plan = runtime.getPlan(planId);
      if (!done && plan !== undefined && plan.status !== "DRAFT") {
        done = true;
        unsubscribe();
        resolve(plan.status);
      }
    };
    unsubscribe = runtime.subscribe(check);
    check();
  });
}

/**
 * What a WebMCP client does with the hero prompt, as the sequence of tool
 * calls it would make: find the capabilities for the task, read what it
 * needs, stage the four operations as one plan through the governance
 * gateway, wait for the person's decision on the card, commit the approved
 * plan, and read the receipts back. Nothing here is page-private; every
 * step is a call any client could make.
 */
export async function runHeroPrompt(runtime: AgentDeskRuntime, prompt = HERO_PROMPT): Promise<ClientOutcome> {
  const routed = await runtime.invoke("find_capabilities", { query: prompt });
  const routedNames = (payload(routed).activated_tools as string[] | undefined) ?? [];
  record({ tool: "find_capabilities", status: status(routed), summary: `${routedNames.length} tools routed: ${routedNames.join(", ")}` });

  const crew = await runtime.invoke("find_stranded_crew", {});
  const crews = (payload(crew).crews as Array<{ name: string; status: string; location: string }> | undefined) ?? [];
  record({
    tool: "find_stranded_crew",
    status: status(crew),
    summary: crews.map((c) => `${c.name} ${c.status} at ${c.location}`).join("; ") || "no crew",
  });
  if (status(crew) !== "ok") {
    return { kind: "refused", step: "find_stranded_crew", reason: crew.content[0]?.text ?? "" };
  }

  const conditions = await runtime.invoke("invoke_capability", { name: "inspect_rescue_conditions" });
  const c = payload(conditions) as { oxygen?: { available: number }; drone?: { status: string }; dock?: { power: number } };
  record({
    tool: "invoke_capability",
    name: "inspect_rescue_conditions",
    status: status(conditions),
    summary: `oxygen ${c.oxygen?.available ?? "?"} available, ${DRONE} ${c.drone?.status ?? "?"}, ${DOCK} at ${c.dock?.power ?? "?"}%`,
  });

  const prepared = await runtime.invoke("invoke_capability", {
    name: "prepare_plan",
    input: { operations: RESCUE_PLAN, summary: PLAN_SUMMARY },
  });
  const planId = payload(prepared).plan_id;
  if (status(prepared) !== "ok" || typeof planId !== "string") {
    record({ tool: "invoke_capability", name: "prepare_plan", status: "refused", summary: prepared.content[0]?.text ?? "" });
    return { kind: "refused", step: "prepare_plan", reason: prepared.content[0]?.text ?? "" };
  }
  record({ tool: "invoke_capability", name: "prepare_plan", status: "ok", summary: `${planId} staged, four operations, awaiting a person` });

  const decision = await decided(runtime, planId);
  if (decision !== "APPROVED") {
    record({ tool: "get_plan", name: planId, status: "ok", summary: `${planId} ${decision.toLowerCase()}; nothing ran` });
    return { kind: "rejected", planId };
  }

  const committed = await runtime.invoke("invoke_capability", { name: "commit_plan", input: { plan_id: planId } });
  const commit = payload(committed) as { ok?: boolean; status?: string; reason?: string };
  record({
    tool: "invoke_capability",
    name: "commit_plan",
    status: commit.ok ? "ok" : "refused",
    summary: commit.ok ? `${planId} ${String(commit.status).toLowerCase()}` : `refused: ${commit.reason ?? "unknown"}`,
  });
  if (!commit.ok) {
    return { kind: "refused", step: "commit_plan", reason: commit.reason ?? "" };
  }

  const receipts = await runtime.invoke("invoke_capability", { name: "query_receipts", input: { plan_id: planId } });
  const count = ((payload(receipts).receipts as unknown[] | undefined) ?? []).length;
  record({ tool: "invoke_capability", name: "query_receipts", status: status(receipts), summary: `${count} receipts for ${planId}` });
  return { kind: "committed", planId, receipts: count };
}
