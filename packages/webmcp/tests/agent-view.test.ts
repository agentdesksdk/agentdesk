import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  type AgentView,
  type Capability,
  type ToolResult,
} from "../src/index.ts";
import { createMockModelContext } from "./mock-model-context.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };

const TOKEN = "tok_secret_9f8e";
const NOTE = "internal-only-note";

/**
 * Application state that carries something the agent must never see, and a
 * catalog that leaks it on every path a value can cross: a handler that
 * returns the raw state, a preview and a receipt that name the field, and
 * a handler that throws with the value in its message.
 */
function state() {
  return {
    orders: [{ id: "10428", total: 42 }],
    paymentToken: TOKEN,
    internalNote: NOTE,
  };
}

/** Removes `paymentToken` at the top level of whatever it is handed. */
const dropToken: AgentView = ({ state: view }) => {
  const { paymentToken: _hidden, ...rest } = view;
  return rest;
};

/** Removes `internalNote`; narrows what the runtime already let through. */
const dropNote: AgentView = ({ state: view }) => {
  const { internalNote: _hidden, ...rest } = view;
  return rest;
};

function catalog(): Capability[] {
  return [
    defineCapability({
      name: "dump_state",
      description: "Returns the whole application state",
      intents: ["dump state"],
      execute: (_input, ctx) => ctx.state,
    }),
    defineCapability({
      name: "read_order",
      description: "Reads an order, narrowed further for the agent",
      intents: ["read order"],
      agentView: dropNote,
      execute: (_input, ctx) => ctx.state,
    }),
    defineCapability({
      name: "rotate_token",
      description: "Rotates the payment token",
      intents: ["rotate token"],
      risk: "CONSEQUENTIAL",
      previewChanges: (_input, ctx) => [
        { field: "paymentToken", before: ctx.state.paymentToken, after: "tok_new" },
        { field: "rotatedAt", before: null, after: "now" },
      ],
      execute: (_input, ctx) =>
        receipt({
          entity: `token ${String(ctx.state.paymentToken)}`,
          changes: [
            { field: "paymentToken", before: ctx.state.paymentToken, after: "tok_new" },
            { field: "rotatedAt", before: null, after: "now" },
          ],
          result: { previous: ctx.state.paymentToken, rotated: true },
        }),
    }),
    defineCapability({
      name: "explode",
      description: "Throws with state in the message",
      intents: ["explode"],
      execute: (_input, ctx) => {
        throw new Error(`failed while holding ${String(ctx.state.paymentToken)}`);
      },
    }),
  ];
}

async function booted(options: { agentView?: AgentView } = {}) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: catalog(),
    actor: AGENT,
    ...(options.agentView ? { agentView: options.agentView } : {}),
  });
  await runtime.start();
  await runtime.setContext({ route: "/orders/10428", state: state() });
  return { model, runtime };
}

/** Everything of a result an agent could read, as one string. */
function serialized(result: ToolResult): string {
  return JSON.stringify(result);
}

describe("agent-view projection: nothing the projection excludes crosses to the agent", () => {
  it("keeps paymentToken out of every result, report, preview, receipt, context, and error text", async () => {
    const { runtime, model } = await booted({ agentView: dropToken });
    const crossed: Array<[string, ToolResult]> = [];

    crossed.push(["get_context", (await model.execute("get_context", {})) as ToolResult]);
    crossed.push([
      "find_capabilities",
      (await model.execute("find_capabilities", { query: "dump state" })) as ToolResult,
    ]);
    crossed.push(["dump_state", await runtime.invoke("dump_state", {})]);
    const requested = await runtime.invoke("rotate_token", {});
    crossed.push(["approval preview", requested]);
    const actionId = runtime.getSnapshot().pending[0]!.id;
    const approved = await runtime.approve(actionId, HUMAN);
    crossed.push(["approved result", approved]);
    crossed.push([
      "get_action_status",
      (await model.execute("get_action_status", { approval_id: actionId })) as ToolResult,
    ]);
    crossed.push(["error text", await runtime.invoke("explode", {})]);

    expect(requested.code).toBe("APPROVAL_REQUIRED");
    expect(approved.data?.status).toBe("COMPLETED");
    for (const [label, result] of crossed) {
      expect(serialized(result), label).not.toContain(TOKEN);
    }
    // The preview and the receipt still say what else changed.
    expect(requested.data?.will_change).toEqual([{ field: "rotatedAt", before: null, after: "now" }]);
    expect(approved.data?.changes).toEqual([{ field: "rotatedAt", before: null, after: "now" }]);
  });

  it("hands a capability that returns the raw state object the projected one", async () => {
    const { runtime } = await booted({ agentView: dropToken });

    const dumped = await runtime.invoke("dump_state", {});

    expect(dumped.data?.result).toEqual({
      orders: [{ id: "10428", total: 42 }],
      internalNote: NOTE,
    });
    expect(JSON.parse(dumped.content[0]!.text)).toEqual({
      orders: [{ id: "10428", total: 42 }],
      internalNote: NOTE,
    });
  });

  it("applies a capability's own view inside the runtime's, never outside it", async () => {
    const { runtime } = await booted({ agentView: dropToken });

    const narrowed = await runtime.invoke("read_order", {});

    expect(narrowed.data?.result).toEqual({ orders: [{ id: "10428", total: 42 }] });
  });

  it("a capability view cannot restore what the runtime's view removed", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      actor: AGENT,
      agentView: dropToken,
      capabilities: [
        defineCapability({
          name: "restore_token",
          description: "Tries to put the token back",
          agentView: ({ state: view }) => ({ ...view, paymentToken: TOKEN, restored: true }),
          execute: (_input, ctx) => ctx.state,
        }),
      ],
    });
    await runtime.start();
    await runtime.setContext({ route: "/", state: state() });

    const result = await runtime.invoke("restore_token", {});

    expect(serialized(result)).not.toContain(TOKEN);
    expect(result.data?.result).toMatchObject({ restored: true });
  });
});

describe("agent-view projection: the human side is untouched", () => {
  it("leaves the snapshot's audit and the receipt store unprojected", async () => {
    const { runtime } = await booted({ agentView: dropToken });
    await runtime.invoke("rotate_token", {});
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);

    const audit = runtime.getSnapshot().audit;
    const completed = audit.find((event) => event.kind === "execution_completed");
    expect(JSON.stringify(completed)).toContain(TOKEN);
    expect(JSON.stringify(runtime.queryReceipts())).toContain(TOKEN);
  });

  it("changes nothing when no projection is declared", async () => {
    const { runtime, model } = await booted();

    const dumped = await runtime.invoke("dump_state", {});
    const context = (await model.execute("get_context", {})) as ToolResult;

    expect(dumped.data?.result).toEqual(state());
    expect(serialized(context)).toContain(TOKEN);
  });
});

describe("agent-view projection: a throwing projection fails closed", () => {
  const exploding: AgentView = () => {
    throw new Error(`projection broke on ${TOKEN}`);
  };

  it("withholds a result and audits the refusal instead of showing the raw state", async () => {
    const { runtime } = await booted({ agentView: exploding });

    const result = await runtime.invoke("dump_state", {});

    expect(result.code).toBe("VIEW_UNAVAILABLE");
    expect(result.isError).toBe(true);
    expect(serialized(result)).not.toContain(TOKEN);
    expect(result.data).not.toHaveProperty("result");
    expect(
      runtime
        .getSnapshot()
        .audit.some(
          (event) =>
            event.kind === "capability_unavailable" && event.reasonCode === "AGENT_VIEW_FAILED",
        ),
    ).toBe(true);
  });

  it("withholds get_context the same way", async () => {
    const { model, runtime } = await booted({ agentView: exploding });

    const context = (await model.execute("get_context", {})) as ToolResult;

    expect(context.code).toBe("VIEW_UNAVAILABLE");
    expect(serialized(context)).not.toContain(TOKEN);
    expect(
      runtime
        .getSnapshot()
        .audit.some(
          (event) =>
            event.kind === "capability_unavailable" && event.reasonCode === "AGENT_VIEW_FAILED",
        ),
    ).toBe(true);
  });

  it("still tells the agent a write completed when only its view failed", async () => {
    let broken = false;
    const failsLater: AgentView = ({ state: view }) => {
      if (broken) {
        throw new Error(`view down on ${TOKEN}`);
      }
      return dropToken({ state: view });
    };
    const { runtime } = await booted({ agentView: failsLater });
    await runtime.invoke("rotate_token", {});
    const actionId = runtime.getSnapshot().pending[0]!.id;

    broken = true;
    const approved = await runtime.approve(actionId, HUMAN);

    expect(approved.code).toBe("VIEW_UNAVAILABLE");
    expect(approved.data?.completed).toBe(true);
    expect(approved.data?.evidence).toEqual(
      expect.arrayContaining([{ kind: "execution", id: expect.stringMatching(/^EXE-/) }]),
    );
    expect(serialized(approved)).not.toContain(TOKEN);
    expect(runtime.queryReceipts()).toHaveLength(1);
  });
});
