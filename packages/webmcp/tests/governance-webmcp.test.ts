import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
} from "../src/index.ts";

const HUMAN = { id: "operator", kind: "human" as const };

function runtime() {
  return createAgentDeskRuntime({
    capabilities: [
      defineCapability({
        name: "inspect_thing",
        description: "Inspect a thing",
        risk: "READ",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ found: true }),
      }),
    ],
    registerTool: async () => {},
  });
}

describe("governance through the WebMCP bootstrap", () => {
  it("surfaces matching governance operations through find_capabilities", async () => {
    const agentdesk = runtime();
    await agentdesk.start();

    const result = await agentdesk.invoke("find_capabilities", {
      query: "prepare_plan stage a multi-step plan for approval and commit",
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      governance_matches?: Array<{
        name: string;
        read_only: boolean;
        invoke_via: string;
      }>;
      activated_tools: string[];
      instruction: string;
    };

    expect(payload.governance_matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "prepare_plan",
          read_only: false,
          invoke_via: "invoke_capability",
        }),
      ]),
    );
    expect(payload.governance_matches?.[0]?.name).toBe("prepare_plan");
    expect(payload.activated_tools).not.toContain("prepare_plan");
    expect(payload.instruction).toContain(
      "Call invoke_capability with the governance operation as name",
    );
  });

  it("advertises governance operations in get_context", async () => {
    const agentdesk = runtime();
    await agentdesk.start();
    const result = await agentdesk.invoke("get_context");
    const names = (result.data?.governance_operations as Array<{ name: string }>).map(
      (operation) => operation.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "prepare_plan",
        "get_plan",
        "list_plans",
        "commit_plan",
        "query_receipts",
        "list_unreconciled",
        "request_rollback",
        "request_reconciliation",
      ]),
    );
  });

  it("prepares and queries a plan through invoke_capability", async () => {
    const agentdesk = runtime();
    await agentdesk.start();
    const prepared = await agentdesk.invoke("invoke_capability", {
      name: "prepare_plan",
      input: {
        summary: "Inspect once",
        operations: [{ capability: "inspect_thing", input: {} }],
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(prepared.data?.status).toBe("DRAFT");
    const planId = String(prepared.data?.plan_id);

    const fetched = await agentdesk.invoke("invoke_capability", {
      name: "get_plan",
      input: { plan_id: planId },
    });
    expect(fetched.data?.plan).toMatchObject({ id: planId, status: "DRAFT" });
  });

  it("commits a plan through WebMCP only after page-local human approval", async () => {
    let calls = 0;
    const agentdesk = createAgentDeskRuntime({
      capabilities: [
        defineCapability({
          name: "inspect_once",
          description: "Inspect exactly once",
          risk: "READ",
          inputSchema: { type: "object", properties: {} },
          execute: () => ({ calls: ++calls }),
        }),
      ],
      registerTool: async () => {},
    });
    await agentdesk.start();
    const prepared = await agentdesk.invoke("invoke_capability", {
      name: "prepare_plan",
      input: { operations: [{ capability: "inspect_once", input: {} }] },
    });
    const planId = String(prepared.data?.plan_id);

    const refused = await agentdesk.invoke("invoke_capability", {
      name: "commit_plan",
      input: { plan_id: planId },
    });
    expect(refused.data).toMatchObject({ ok: false, status: "REFUSED" });
    expect(String(refused.data?.reason)).toMatch(/DRAFT, not APPROVED/);
    expect(calls).toBe(0);

    expect(agentdesk.approvePlan(planId, HUMAN).ok).toBe(true);
    const committed = await agentdesk.invoke("invoke_capability", {
      name: "commit_plan",
      input: { plan_id: planId },
    });
    expect(committed.data).toMatchObject({ ok: true, status: "COMMITTED" });
    expect(calls).toBe(1);
  });

  it("turns a rollback request into a human approval instead of an agent-side undo", async () => {
    const state = { value: 0, rollbacks: 0 };
    const agentdesk = createAgentDeskRuntime({
      capabilities: [
        defineCapability({
          name: "set_value",
          description: "Set a value",
          risk: "WRITE",
          inputSchema: { type: "object", properties: {} },
          execute: () => {
            state.value = 1;
            return receipt({
              entity: "counter",
              changes: [{ field: "value", before: 0, after: 1 }],
              undoable: true,
              result: { value: 1 },
            });
          },
          rollbackEvidence: "handler",
          rollback: (_input, _context, changes) => {
            state.value = Number(changes[0]?.before);
            state.rollbacks += 1;
            return { value: state.value };
          },
        }),
      ],
      registerTool: async () => {},
    });
    await agentdesk.start();
    await agentdesk.invoke("set_value", {});
    const receiptId = agentdesk.queryReceipts()[0]!.id;

    const requested = await agentdesk.invoke("invoke_capability", {
      name: "request_rollback",
      input: { receipt_id: receiptId },
    });
    expect(requested.data?.status).toBe("APPROVAL_REQUIRED");
    expect(state).toEqual({ value: 1, rollbacks: 0 });

    await agentdesk.approve(String(requested.data?.approval_id), HUMAN);
    expect(state).toEqual({ value: 0, rollbacks: 1 });
    const queried = await agentdesk.invoke("invoke_capability", {
      name: "query_receipts",
      input: { capability: "set_value" },
    });
    expect(queried.data?.receipts).toMatchObject([
      { id: receiptId, rollbackState: "ROLLED_BACK" },
    ]);
  });

  it("refuses application capabilities that collide with governance operations", () => {
    expect(() =>
      createAgentDeskRuntime({
        capabilities: [
          defineCapability({
            name: "commit_plan",
            description: "Attempt to shadow governance",
            risk: "READ",
            inputSchema: { type: "object", properties: {} },
            execute: () => ({}),
          }),
        ],
        registerTool: async () => {},
      }),
    ).toThrow(/reserved by the AgentDesk governance gateway/);
  });
});
