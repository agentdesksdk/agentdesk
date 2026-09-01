import { createWebMcpClient, type Actor, type ToolResult } from "@agentdesk/webmcp";
import { ARMS } from "../../scripts/evals/arms.mjs";
import {
  armFromSearch,
  createEvalRuntime,
  EVAL_TASKS,
  type ArmName,
} from "./eval-page.ts";

/** The person driving the tasks. Approving is a human act, not the agent's. */
const OPERATOR: Actor = { id: "evaluator", name: "Evaluator", kind: "human" };

type ModelContextHost = { modelContext?: { registerTool?: unknown } };

/** True when the browser exposes real WebMCP. */
const webmcpNative =
  typeof (document as unknown as ModelContextHost).modelContext?.registerTool ===
  "function";

/**
 * Without native WebMCP the surface is registered into an in-page sink, the
 * same shape of sink arms.mjs records into, so the counts a client would be
 * handed stay observable. The banner says which of the two is in effect.
 */
function newSession(arm: ArmName) {
  return createEvalRuntime({
    arm,
    ...(webmcpNative ? {} : { registerTool: async () => {} }),
  });
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

function armLink(name: ArmName): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = `?arm=${name}`;
  link.textContent = ARMS[name].label;
  return link;
}

const arm = armFromSearch(location.search);

if (arm === null) {
  // No arm, no runtime. Picking one silently would leave a person driving
  // tasks against an exposure they did not choose.
  el("arm-label").textContent = "No arm selected";
  el("arm-exposure").textContent = "";
  el("support").textContent =
    "Add ?arm=baseline or ?arm=agentdesk to the URL. Nothing is mounted until an arm is chosen.";
  el("support").className = "banner warn";
  const chooser = el("arm-switch");
  chooser.textContent = "";
  for (const name of Object.keys(ARMS) as ArmName[]) {
    chooser.append(armLink(name), document.createTextNode(" "));
  }
  el("runtime-panels").hidden = true;
} else {
  const armName = arm.arm as ArmName;
  let session = newSession(armName);
  let unsubscribe = () => {};
  const invocationLog: string[] = [];

  el("arm-label").textContent = arm.label;
  el("arm-exposure").textContent = `exposure: ${arm.exposure}`;
  const switcher = el("arm-switch");
  switcher.textContent = "";
  for (const name of Object.keys(ARMS) as ArmName[]) {
    if (name !== armName) {
      switcher.append(document.createTextNode("Switch to "), armLink(name));
    }
  }

  function logInvocation(label: string, result: ToolResult): void {
    const text = result.content[0]?.text ?? "";
    invocationLog.unshift(
      `${new Date().toLocaleTimeString([], { hour12: false })}  ${label} → ${text.slice(0, 220)}`,
    );
    if (invocationLog.length > 30) {
      invocationLog.pop();
    }
    paint();
  }

  function paint(): void {
    const { runtime } = session;
    const snapshot = runtime.getSnapshot();
    el("support").textContent = webmcpNative
      ? "WebMCP native: YES. document.modelContext.registerTool is live; connect a client and paste a task prompt."
      : "WebMCP native: NO. The surface is registered into an in-page sink so the counts below are what a client would be handed. For a real run open this page in a WebMCP-capable client (Codex in-app browser, or Chrome with chrome://flags/#enable-webmcp-testing). window.agentdesk works in-page either way.";
    el("support").className = `banner ${webmcpNative ? "ok" : "warn"}`;

    el("stat-catalog").textContent = String(snapshot.catalogSize);
    el("stat-native").textContent = String(snapshot.nativeTools.length);
    el("stat-bytes").textContent = snapshot.schemaBytes.toLocaleString();
    el("stat-pending").textContent = String(snapshot.pending.length);
    el("stat-refunded").textContent = String(session.store.refunded.size);
    el("stat-closed").textContent = String(session.store.closed.size);

    el("active-tools").textContent = snapshot.nativeTools.join("\n") || "(none)";
    el("retired-tools").textContent = snapshot.tombstones.join("\n") || "(none)";

    const pending = el("pending");
    pending.textContent = "";
    for (const action of snapshot.pending) {
      const row = document.createElement("div");
      row.className = "pending-row";
      const label = document.createElement("span");
      label.textContent = `${action.id}  ${action.summary}`;
      const approve = document.createElement("button");
      approve.textContent = "Approve";
      approve.setAttribute("aria-label", `Approve ${action.summary}`);
      approve.addEventListener("click", () => {
        void runtime
          .approve(action.id, OPERATOR)
          .then((result) => logInvocation(`approve ${action.id}`, result));
      });
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      reject.setAttribute("aria-label", `Reject ${action.summary}`);
      reject.addEventListener("click", () => {
        logInvocation(`reject ${action.id}`, runtime.reject(action.id, OPERATOR));
      });
      row.append(label, approve, reject);
      pending.append(row);
    }
    if (snapshot.pending.length === 0) {
      pending.textContent = "(no pending approvals)";
    }

    el("invocations").textContent = invocationLog.join("\n") || "(none yet)";
    el("events").textContent = [...snapshot.audit]
      .slice(-40)
      .reverse()
      .map((event) => {
        const time = new Date(event.at).toLocaleTimeString([], { hour12: false });
        const rest = Object.entries(event)
          .filter(([key]) => key !== "kind" && key !== "at")
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" ");
        return `${time}  ${event.kind}  ${rest}`;
      })
      .join("\n");
  }

  async function mount(): Promise<void> {
    unsubscribe();
    unsubscribe = session.runtime.subscribe(() => paint());
    await session.runtime.start();
    // The consumer surface, for manual getTools/executeTool checks, as on the
    // compatibility harness.
    Object.assign(window, {
      agentdesk: session.runtime,
      agentdeskClient: createWebMcpClient(),
    });
    paint();
  }

  // Reset is a fresh catalog on a fresh runtime, the unit run.mjs builds per
  // task. Nothing is rolled back; the previous store is simply dropped.
  el("btn-reset").addEventListener("click", () => {
    void (async () => {
      unsubscribe();
      unsubscribe = () => {};
      await session.runtime.stop();
      session = newSession(armName);
      invocationLog.length = 0;
      await mount();
      el("reset-status").textContent = `Store reset to seed at ${new Date().toLocaleTimeString([], { hour12: false })}.`;
    })();
  });

  const tasks = el("tasks");
  tasks.textContent = "";
  for (const task of EVAL_TASKS) {
    const item = document.createElement("li");
    const prompt = document.createElement("blockquote");
    prompt.textContent = task.prompt;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = [
      task.id,
      `terminal tool: ${task.terminalTool}`,
      task.consequential ? "expects approval" : "no approval expected",
      task.unsafe ? "expects refusal" : "",
    ]
      .filter((part) => part !== "")
      .join(" · ");
    item.append(prompt, meta);
    tasks.append(item);
  }

  void mount();
}
