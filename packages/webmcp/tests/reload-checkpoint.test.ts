import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  memoryPersistence,
  receipt,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator", kind: "human" as const };

function capability() {
  let value = 0;
  return {
    definition: defineCapability({
      name: "set_value",
      description: "Set a value",
      risk: "CONSEQUENTIAL",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
      previewChanges: (input) => [
        { field: "value", before: value, after: input.value },
      ],
      execute: (input) => {
        value = Number(input.value);
        return receipt({
          entity: "counter",
          changes: [{ field: "value", before: 0, after: value }],
          undoable: false,
          result: { value },
        });
      },
    }),
    value: () => value,
  };
}

describe("runtime checkpoints", () => {
  it("rehydrates a pending approval and lets the human decide it", async () => {
    const persistence = memoryPersistence();
    const firstCapability = capability();
    const first = createAgentDeskRuntime({
      capabilities: [firstCapability.definition],
      registerTool: async () => {},
      persistence,
    });
    await first.start();
    const asked = await first.invoke("set_value", { value: 7 });
    const approvalId = String(asked.data?.approval_id);
    expect(first.getSnapshot().pending.map((action) => action.id)).toEqual([approvalId]);

    const secondCapability = capability();
    const second = createAgentDeskRuntime({
      capabilities: [secondCapability.definition],
      registerTool: async () => {},
      persistence,
    });
    await second.start();

    expect(second.getSnapshot().pending.map((action) => action.id)).toEqual([approvalId]);
    const approved = await second.approve(approvalId, HUMAN);
    expect(approved.data?.status).toBe("COMPLETED");
    expect(secondCapability.value()).toBe(7);
  });

  it("rehydrates completed receipts", async () => {
    const persistence = memoryPersistence();
    const firstCapability = capability();
    const first = createAgentDeskRuntime({
      capabilities: [firstCapability.definition],
      registerTool: async () => {},
      persistence,
    });
    await first.start();
    const asked = await first.invoke("set_value", { value: 9 });
    await first.approve(String(asked.data?.approval_id), HUMAN);
    const receipt = first.queryReceipts()[0]!;

    const second = createAgentDeskRuntime({
      capabilities: [capability().definition],
      registerTool: async () => {},
      persistence,
    });
    await second.start();

    expect(second.queryReceipts()).toEqual([receipt]);
  });

  it("rehydrates the exact staged artifact behind a pending approval", async () => {
    type Artifact = { before: number; after: number; settled: boolean };
    let value = 0;
    let commits = 0;
    const adapter: StagingAdapter<Artifact> = {
      operations: ["set_value"],
      scope: (run) => run(),
      fork: (_operation, input) => ({
        staged: { before: value, after: Number(input.value), settled: false },
        result: undefined,
      }),
      diff: (artifact) => [
        { field: "value", before: artifact.before, after: artifact.after },
      ],
      commit: (artifact) => {
        artifact.settled = true;
        value = artifact.after;
        commits += 1;
        return receipt({
          entity: "counter",
          changes: [{ field: "value", before: artifact.before, after: artifact.after }],
          undoable: false,
          result: { value },
        });
      },
      release: (artifact) => {
        artifact.settled = true;
      },
      reconcile: (artifact) => {
        artifact.settled = true;
      },
    };
    const definition = defineCapability({
      name: "set_value",
      description: "Set a value through a staged artifact",
      risk: "CONSEQUENTIAL",
      staging: { operation: "set_value" },
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
    });
    const persistence = memoryPersistence();
    const first = createAgentDeskRuntime({
      capabilities: [definition],
      registerTool: async () => {},
      persistence,
      staging: adapter,
    });
    await first.start();
    const asked = await first.invoke("set_value", { value: 11 });
    const approvalId = String(asked.data?.approval_id);

    const second = createAgentDeskRuntime({
      capabilities: [definition],
      registerTool: async () => {},
      persistence,
      staging: adapter,
    });
    await second.start();
    const approved = await second.approve(approvalId, HUMAN);

    expect(approved.data?.status).toBe("COMPLETED");
    expect(value).toBe(11);
    expect(commits).toBe(1);
  });

  it("replays the exact settled idempotent result after reload", async () => {
    const persistence = memoryPersistence();
    let calls = 0;
    const definition = defineCapability({
      name: "read_once",
      description: "Return a stable result once",
      risk: "READ",
      inputSchema: { type: "object", properties: {} },
      availability: () =>
        calls === 0
          ? { available: true }
          : {
              available: false,
              reasonCode: "ALREADY_READ",
              reason: "The one-time value was already read.",
            },
      execute: () => ({ call: ++calls }),
    });
    const first = createAgentDeskRuntime({
      capabilities: [definition],
      registerTool: async () => {},
      persistence,
    });
    await first.start();
    const initial = await first.invoke("invoke_capability", {
      name: "read_once",
      input: {},
      idempotency_key: "same-key",
    });

    const second = createAgentDeskRuntime({
      capabilities: [definition],
      registerTool: async () => {},
      persistence,
    });
    await second.start();
    const replay = await second.invoke("invoke_capability", {
      name: "read_once",
      input: {},
      idempotency_key: "same-key",
    });

    expect(replay).toEqual(initial);
    expect(calls).toBe(1);
  });
});
