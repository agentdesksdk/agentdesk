import type { AgentDeskRuntime, ToolResult } from "@agentdesksdk/webmcp";

/**
 * A SCRIPTED WALKTHROUGH, NOT AN AGENT.
 *
 * This module is page code calling the runtime's tools in a fixed order,
 * so a person with no WebMCP client at hand can watch the plan, approval,
 * and receipt happen. It is loaded only when the URL carries
 * `?walkthrough=1`, it says what it is on screen, and nothing in the
 * normal page imports it. An agent interprets a prompt; this replays one.
 */
const PROMPT =
  "Find the stranded Asteria crew. Prepare a rescue plan that reserves two oxygen packs, assigns rescue drone NIA-7, reroutes power to Dock 3, and launches the rescue. Do not launch without my approval.";

const OPERATIONS = [
  { capability: "reserve_oxygen", input: { packs: 2 } },
  { capability: "assign_rescue_drone", input: { drone: "NIA-7", mission: "AST-10428" } },
  { capability: "reroute_dock_power", input: { dock: "Dock 3", percent: 65 } },
  { capability: "launch_rescue", input: { mission: "AST-10428" } },
];

const SUMMARY = "Rescue the Asteria crew: reserve two oxygen packs, assign NIA-7, reroute power to Dock 3, launch AST-10428.";

function text(result: ToolResult): Record<string, unknown> {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function decided(runtime: AgentDeskRuntime, planId: string): Promise<string> {
  return new Promise((resolve) => {
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

/** Mounts the labelled panel. Returns a function that removes it. */
export function installWalkthrough(runtime: AgentDeskRuntime): () => void {
  const panel = document.createElement("section");
  panel.className = "walkthrough";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Scripted walkthrough, not an agent");
  panel.innerHTML = `
    <h2>Scripted walkthrough, not an agent</h2>
    <p>This panel is page code that calls the runtime's tools in a fixed order, so the flow can be watched without a WebMCP client. It replays one prompt; it does not interpret it. It appears only with <code>?walkthrough=1</code>.</p>
    <button type="button" class="primary">Replay the scripted rescue</button>
    <p class="walkthrough-status" role="status" aria-live="polite"></p>
  `;
  const button = panel.querySelector("button")!;
  const status = panel.querySelector(".walkthrough-status")!;
  const say = (words: string) => {
    status.textContent = words;
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      say("Scripted: find_capabilities with the prompt");
      await runtime.invoke("find_capabilities", { query: PROMPT });
      say("Scripted: find_stranded_crew");
      await runtime.invoke("find_stranded_crew", {});
      say("Scripted: invoke_capability inspect_rescue_conditions");
      await runtime.invoke("invoke_capability", { name: "inspect_rescue_conditions" });
      say("Scripted: invoke_capability prepare_plan");
      const prepared = text(await runtime.invoke("invoke_capability", { name: "prepare_plan", input: { operations: OPERATIONS, summary: SUMMARY } }));
      const planId = prepared.plan_id;
      if (typeof planId !== "string") {
        say(`Scripted: prepare_plan refused: ${JSON.stringify(prepared)}`);
        return;
      }
      say(`Scripted: ${planId} staged; waiting for you to decide on the card`);
      const decision = await decided(runtime, planId);
      if (decision !== "APPROVED") {
        say(`Scripted: ${planId} ${decision.toLowerCase()}; the script stops`);
        return;
      }
      say("Scripted: invoke_capability commit_plan");
      const committed = text(await runtime.invoke("invoke_capability", { name: "commit_plan", input: { plan_id: planId } }));
      say("Scripted: invoke_capability query_receipts");
      const receipts = text(await runtime.invoke("invoke_capability", { name: "query_receipts", input: { plan_id: planId } }));
      const count = ((receipts.receipts as unknown[] | undefined) ?? []).length;
      say(`Scripted: ${planId} ${String(committed.status).toLowerCase()}, ${count} receipts read back`);
    } finally {
      button.disabled = false;
    }
  });

  document.body.appendChild(panel);
  return () => panel.remove();
}
