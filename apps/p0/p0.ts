import {
  createAgentDeskRuntime,
  createWebMcpClient,
  type AppContext,
  type ToolResult,
} from "@agentdesk/webmcp";
import { p0Capabilities } from "./capabilities.ts";

const runtime = createAgentDeskRuntime({ capabilities: p0Capabilities });

const scenes: AppContext[] = [
  { route: "/", state: {} },
  { route: "/alpha", state: {} },
  { route: "/beta", state: {} },
];
let sceneIndex = 0;
let helloRetired = false;
const invocationLog: string[] = [];

function currentContext(): AppContext {
  const scene = scenes[sceneIndex % scenes.length]!;
  const state: Record<string, unknown> = { ...scene.state };
  if (helloRetired) {
    state.helloRetired = true;
  }
  return { route: scene.route, state };
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

function logInvocation(label: string, result: ToolResult): void {
  const text = result.content[0]?.text ?? "";
  invocationLog.unshift(`${new Date().toLocaleTimeString([], { hour12: false })}  ${label} → ${text.slice(0, 220)}`);
  if (invocationLog.length > 30) {
    invocationLog.pop();
  }
  paint();
}

function paint(): void {
  const snapshot = runtime.getSnapshot();
  el("support").textContent = snapshot.supported
    ? "WebMCP native: YES — document.modelContext.registerTool is live."
    : "WebMCP native: NO — open in ChatGPT's in-app browser or Chrome with chrome://flags/#enable-webmcp-testing. The compatibility path still works in-page via window.agentdesk.";
  el("support").className = `banner ${snapshot.supported ? "ok" : "warn"}`;

  const audit = snapshot.audit;
  const count = (kind: string) => audit.filter((event) => event.kind === kind).length;
  el("stat-registered").textContent = String(count("tool_registered"));
  el("stat-retired").textContent = String(count("tool_retired"));
  el("stat-invocations").textContent = String(count("capability_invoked"));
  el("stat-aborts").textContent = String(count("tool_retired"));
  el("stat-dynamic").textContent = String(count("capability_routed"));
  el("stat-stale").textContent = String(
    audit.filter(
      (event) =>
        event.kind === "capability_unavailable" &&
        event.reasonCode === "CAPABILITY_RETIRED",
    ).length,
  );

  el("active-tools").textContent = snapshot.nativeTools.join("\n") || "(none)";
  el("retired-tools").textContent = snapshot.tombstones.join("\n") || "(none)";
  el("route").textContent = `${snapshot.route}${helloRetired ? "  [hello retired]" : ""}`;

  el("pending").innerHTML = "";
  for (const action of snapshot.pending) {
    const row = document.createElement("div");
    row.className = "pending-row";
    const label = document.createElement("span");
    label.textContent = `${action.id}  ${action.summary}`;
    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.addEventListener("click", () => {
      void runtime.approve(action.id).then((result) => logInvocation(`approve ${action.id}`, result));
    });
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.addEventListener("click", () => {
      logInvocation(`reject ${action.id}`, runtime.reject(action.id));
    });
    row.append(label, approve, reject);
    el("pending").append(row);
  }
  if (snapshot.pending.length === 0) {
    el("pending").textContent = "(no pending approvals)";
  }

  el("invocations").textContent = invocationLog.join("\n") || "(none yet)";

  el("events").textContent = [...audit]
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

runtime.subscribe(() => paint());
await runtime.start();

async function invokeAndLog(name: string, input?: Record<string, unknown>): Promise<void> {
  const result = await runtime.invoke(name, input);
  logInvocation(`${name}(${input ? JSON.stringify(input) : ""})`, result);
}

el("btn-register").addEventListener("click", () => {
  helloRetired = false;
  void runtime
    .setContext(currentContext())
    .then(() => invokeAndLog("find_capabilities", { query: "hello greet" }));
});

el("btn-retire").addEventListener("click", () => {
  helloRetired = true;
  void runtime.setContext(currentContext());
});

el("btn-reregister").addEventListener("click", () => {
  helloRetired = false;
  void runtime
    .setContext(currentContext())
    .then(() => invokeAndLog("find_capabilities", { query: "hello greet" }));
});

el("btn-scene").addEventListener("click", () => {
  sceneIndex = (sceneIndex + 1) % scenes.length;
  void runtime.setContext(currentContext());
});

el("btn-reset").addEventListener("click", () => {
  sceneIndex = 0;
  helloRetired = false;
  invocationLog.length = 0;
  void runtime.setContext(currentContext()).then(() => runtime.reset());
});

el("btn-hello").addEventListener("click", () => {
  void invokeAndLog("hello_dynamic_tool", { name: "P0" });
});

el("btn-invoke-compat").addEventListener("click", () => {
  void invokeAndLog("invoke_capability", {
    name: "hello_dynamic_tool",
    input: { name: "compat" },
  });
});

el("btn-approval").addEventListener("click", () => {
  void invokeAndLog("request_demo_approval", { note: "P0 harness test" });
});

el("btn-context").addEventListener("click", () => {
  void invokeAndLog("get_context");
});

// The consumer surface is half of what this harness exists to check, so
// expose it for manual getTools/executeTool conformance runs.
Object.assign(window, {
  agentdesk: runtime,
  agentdeskClient: createWebMcpClient(),
});
paint();
