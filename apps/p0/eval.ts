import {
  createWebMcpClient,
  type Actor,
  type NativeToolDefinition,
  type RegisterToolOptions,
  type ToolResult,
} from "@agentdesksdk/webmcp";
import {
  cellFromSearch,
  cellHref,
  createEvalRuntime,
  EVAL_CELLS,
  EVAL_TASKS,
  type Cell,
} from "./eval-page.ts";

/** The person driving the tasks. Approving is a human act, not the agent's. */
const OPERATOR: Actor = { id: "evaluator", name: "Evaluator", kind: "human" };

type NativeRegisterTool = (
  tool: NativeToolDefinition,
  options?: RegisterToolOptions,
) => Promise<void> | void;
type ModelContextHost = { modelContext?: { registerTool?: NativeRegisterTool } };

/** The browser's own registration, when it exposes real WebMCP. */
const nativeRegisterTool = (document as unknown as ModelContextHost).modelContext?.registerTool;
const webmcpNative = typeof nativeRegisterTool === "function";

/**
 * The page always supplies the runtime's `registerTool`, because that is
 * where the cell's shape is applied: `createEvalRuntime` wraps every tool
 * before it reaches the sink below or, when the browser has WebMCP, the
 * page's `document.modelContext`. A client on a bare cell therefore holds
 * bare tools; the runtime is never handed the native surface directly.
 * Without native WebMCP the surface goes into an in-page sink, the same
 * shape of sink arms.mjs records into, so the counts stay observable.
 */
function newSession(cell: Cell) {
  const register: NativeRegisterTool = webmcpNative
    ? (tool, options) => nativeRegisterTool!.call(
        (document as unknown as ModelContextHost).modelContext,
        tool,
        options,
      )
    : async () => {};
  return createEvalRuntime({
    arm: cell.arm,
    shape: cell.shape,
    registerTool: async (tool, options) => {
      await register(tool, options);
    },
  });
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

function cellLink(cell: Cell): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = cellHref(cell);
  link.textContent = cell.label;
  return link;
}

const cell = cellFromSearch(location.search);

if (cell === null) {
  // No cell, no runtime. Picking an arm or a shape silently would leave a
  // person driving tasks against a cell they did not choose, and recording
  // the transcript under the wrong one.
  el("arm-label").textContent = "No cell selected";
  el("arm-exposure").textContent = "";
  el("support").textContent =
    "Add ?arm=baseline or ?arm=agentdesk and ?shape=structured or ?shape=bare to the URL. Nothing is mounted until both are chosen.";
  el("support").className = "banner warn";
  const chooser = el("arm-switch");
  chooser.textContent = "";
  for (const option of Object.values(EVAL_CELLS)) {
    chooser.append(cellLink(option), document.createTextNode(" "));
  }
  el("runtime-panels").hidden = true;
} else {
  // Narrowed once; the closures below outlive the check above.
  const current: Cell = cell;
  let session = newSession(current);
  let unsubscribe = () => {};
  const invocationLog: string[] = [];

  el("arm-label").textContent = current.label;
  el("arm-exposure").textContent = `exposure: ${current.exposure} · shape: ${current.shape}`;
  const switcher = el("arm-switch");
  switcher.textContent = "";
  for (const option of Object.values(EVAL_CELLS)) {
    if (option !== current) {
      switcher.append(document.createTextNode("Switch to "), cellLink(option), document.createTextNode(" "));
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
      ? `WebMCP native: YES. document.modelContext.registerTool is live and every tool is handed over in the ${current.shape} shape; connect a client and paste a task prompt.`
      : `WebMCP native: NO. The surface is registered into an in-page sink in the ${current.shape} shape, so the counts below are what a client would be handed. For a real run open this page in a WebMCP-capable client (Codex in-app browser, or Chrome with chrome://flags/#enable-webmcp-testing). window.agentdesk works in-page either way and is not projected.`;
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
    // compatibility harness. `window.agentdesk` is the runtime itself and is
    // not projected; a client reaches the projected tools through
    // document.modelContext.
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
      session = newSession(current);
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
