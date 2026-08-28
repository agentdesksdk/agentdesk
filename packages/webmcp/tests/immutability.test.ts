import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { defaultValidator, unsupportedSchemaKeywords } from "../src/validation.ts";
import { createMockModelContext } from "./mock-model-context.ts";

describe("approved input is protected from snapshot mutation", () => {
  it("mutating a pending action through getSnapshot cannot change what executes", async () => {
    const model = createMockModelContext();
    const seen: unknown[] = [];
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "issue_credit",
          description: "Issues a credit",
          risk: "CONSEQUENTIAL",
          inputSchema: {
            type: "object",
            properties: { amount: { type: "number" } },
          },
          previewChanges: (input) => [
            { field: "credit", before: 0, after: Number(input.amount) },
          ],
          execute: (input) => {
            seen.push(input.amount);
            return { credited: input.amount };
          },
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("issue_credit", { amount: 10 });

    const pending = runtime.getSnapshot().pending[0]!;
    (pending.input as Record<string, unknown>).amount = 999;
    (pending.preview as Array<{ after: unknown }>)[0]!.after = 999;
    pending.preview.push({ field: "injected", before: null, after: "evil" });

    await runtime.approve(pending.id);
    expect(seen).toEqual([10]);
  });

  it("the stored preview survives mutation of a snapshot copy", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "wipe_data",
          description: "Wipes data",
          risk: "CONSEQUENTIAL",
          previewChanges: () => [
            { field: "records", before: 10, after: 0 },
          ],
          execute: () => "wiped",
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("wipe_data", {});

    const first = runtime.getSnapshot().pending[0]!;
    first.preview[0]!.field = "tampered";

    const second = runtime.getSnapshot().pending[0]!;
    expect(second.preview[0]!.field).toBe("records");
  });
});

/** A frozen target rejects writes loudly in strict mode. Either way the
 * invariant under test is that stored history did not change. */
function attemptTamper(mutate: () => void): void {
  try {
    mutate();
  } catch {
    /* frozen */
  }
}

describe("audit history is immutable", () => {
  async function startWithReceipt() {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "ship_order",
          description: "Ships an order",
          risk: "WRITE",
          execute: () => "shipped",
        }),
      ],
    });
    await runtime.start();
    return runtime;
  }

  it("mutating a snapshot event cannot rewrite stored history", async () => {
    const runtime = await startWithReceipt();
    await runtime.invoke("ship_order", {});

    const events = runtime.getSnapshot().audit;
    const completed = events.find((e) => e.kind === "execution_completed")!;
    attemptTamper(() => {
      (completed as { capability: string }).capability = "tampered";
    });

    const later = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed")!;
    expect((later as { capability: string }).capability).toBe("ship_order");
  });

  it("a listener cannot mutate the stored event", async () => {
    const runtime = await startWithReceipt();
    runtime.subscribeAudit((event) => {
      attemptTamper(() => {
        (event as { capability: string }).capability = "listener-tampered";
      });
    });
    await runtime.invoke("ship_order", {});

    const stored = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed")!;
    expect((stored as { capability: string }).capability).toBe("ship_order");
  });

  it("nested receipt data is detached too", async () => {
    const model = createMockModelContext();
    const { receipt } = await import("../src/results.ts");
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "refund_fee",
          description: "Refunds a fee",
          risk: "WRITE",
          execute: () =>
            receipt({
              entity: "Order #1",
              changes: [{ field: "refunded", before: false, after: true }],
              result: { ok: true },
            }),
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("refund_fee", {});

    const event = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed")!;
    if (event.kind === "execution_completed" && event.receipt) {
      const receiptRef = event.receipt;
      attemptTamper(() => {
        receiptRef.changes[0]!.after = "tampered";
      });
      attemptTamper(() => {
        receiptRef.entity = "tampered";
      });
    }

    const later = runtime
      .getSnapshot()
      .audit.find((e) => e.kind === "execution_completed")!;
    if (later.kind === "execution_completed") {
      expect(later.receipt?.entity).toBe("Order #1");
      expect(later.receipt?.changes[0]!.after).toBe(true);
    }
  });
});

describe("approval recovers when a check throws", () => {
  it("a throwing policy resolves the action instead of stranding it", async () => {
    const model = createMockModelContext();
    let throwNow = false;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      policy: () => {
        if (throwNow) {
          throw new Error("policy backend unreachable");
        }
        return { kind: "require_approval" };
      },
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Refunds shipping",
          risk: "CONSEQUENTIAL",
          previewChanges: () => [],
          execute: () => "refunded",
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("refund_shipping", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    throwNow = true;
    const outcome = await runtime.approve(id);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]!.text).toContain("policy backend unreachable");

    const status = await runtime.invoke("get_action_status", {
      approval_id: id,
    });
    expect(JSON.parse(status.content[0]!.text).status).toBe("FAILED");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });

  it("a throwing availability check resolves the action", async () => {
    const model = createMockModelContext();
    let throwNow = false;
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "cancel_order",
          description: "Cancels an order",
          risk: "CONSEQUENTIAL",
          previewChanges: () => [],
          availability: () => {
            if (throwNow) {
              throw new Error("state store unreachable");
            }
            return { available: true };
          },
          execute: () => "cancelled",
        }),
      ],
    });
    await runtime.start();
    await runtime.invoke("cancel_order", {});
    const id = runtime.getSnapshot().pending[0]!.id;

    throwNow = true;
    const outcome = await runtime.approve(id);
    expect(outcome.isError).toBe(true);

    const status = await runtime.invoke("get_action_status", {
      approval_id: id,
    });
    const record = JSON.parse(status.content[0]!.text);
    expect(record.status).toBe("FAILED_UNAVAILABLE");
    expect(record.reasonCode).toBe("AVAILABILITY_CHECK_FAILED");
    expect(runtime.getSnapshot().pending).toHaveLength(0);
  });
});

describe("validator enforces and reports every supported value shape", () => {
  it("enforces union types", () => {
    const schema = {
      type: "object" as const,
      properties: { id: { type: ["string", "null"] } },
    };
    expect(defaultValidator(schema, { id: 42 }).valid).toBe(false);
    expect(defaultValidator(schema, { id: "abc" }).valid).toBe(true);
    expect(defaultValidator(schema, { id: null }).valid).toBe(true);
  });

  it("required checks presence, not emptiness", () => {
    const schema = {
      type: "object" as const,
      required: ["name"],
      properties: { name: { type: "string" } },
    };
    expect(defaultValidator(schema, { name: "" }).valid).toBe(true);
    expect(defaultValidator(schema, {}).valid).toBe(false);
  });

  it("minLength owns empty-string rejection", () => {
    const schema = {
      type: "object" as const,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    };
    expect(defaultValidator(schema, { name: "" }).valid).toBe(false);
    expect(defaultValidator(schema, { name: "a" }).valid).toBe(true);
  });

  it("reports keyword value shapes it cannot enforce", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { a: { items: [{ type: "string" }] } },
      } as never),
    ).toContain("items");

    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { a: { enum: "not-an-array" } },
      } as never),
    ).toContain("enum");

    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { a: { type: 42 } },
      } as never),
    ).toContain("type");
  });

  it("accepts a union type as supported", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { a: { type: ["string", "null"] } },
      } as never),
    ).toEqual([]);
  });
});

describe("consequential approval evidence is an explicit choice", () => {
  it("refuses a consequential capability that declares neither", () => {
    expect(() =>
      defineCapability({
        name: "wipe_account",
        description: "Destroys data",
        risk: "CONSEQUENTIAL",
        execute: () => "wiped",
      }),
    ).toThrow(/previewChanges or opt in to approvalEvidence/);
  });

  it("refuses a diff declaration with no preview to back it", () => {
    expect(() =>
      defineCapability({
        name: "wipe_account",
        description: "Destroys data",
        risk: "CONSEQUENTIAL",
        approvalEvidence: "diff",
        execute: () => "wiped",
      }),
    ).toThrow(/no previewChanges/);
  });

  it("accepts an explicit summary-only consequential capability", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "send_apology_email",
          description: "Sends an email with no enumerable diff",
          risk: "CONSEQUENTIAL",
          approvalEvidence: "summary",
          describeApproval: () => "Email the customer an apology.",
          execute: () => "sent",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("send_apology_email", {});
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.approvalEvidence).toBe("summary");
    expect(result.data?.will_change).toBeUndefined();
  });

  it("a capability with a preview reports diff evidence", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "refund_shipping",
          description: "Refunds shipping",
          risk: "CONSEQUENTIAL",
          previewChanges: () => [
            { field: "refunded", before: false, after: true },
          ],
          execute: () => "refunded",
        }),
      ],
    });
    await runtime.start();
    const result = await runtime.invoke("refund_shipping", {});
    expect(result.data?.approvalEvidence).toBe("diff");
    expect(result.data?.will_change).toHaveLength(1);
  });

  it("WRITE capabilities are unaffected by the contract", () => {
    expect(() =>
      defineCapability({
        name: "add_note",
        description: "Adds a note",
        risk: "WRITE",
        execute: () => "noted",
      }),
    ).not.toThrow();
  });
});

describe("idempotency never evicts an in-flight execution", () => {
  it("retrying the oldest key while it is still running does not re-execute", async () => {
    const model = createMockModelContext();
    let runs = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "charge_card",
          description: "Charges a card",
          risk: "WRITE",
          execute: async () => {
            runs += 1;
            await gate;
            return "charged";
          },
        }),
      ],
    });
    await runtime.start();

    const inFlight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 513; i++) {
      inFlight.push(
        runtime.invoke("invoke_capability", {
          name: "charge_card",
          idempotency_key: `key-${i}`,
        }),
      );
    }
    const runsAfterFill = runs;
    inFlight.push(
      runtime.invoke("invoke_capability", {
        name: "charge_card",
        idempotency_key: "key-0",
      }),
    );
    expect(runs).toBe(runsAfterFill);

    release();
    await Promise.all(inFlight);
  });

  it("property order does not create a false conflict", async () => {
    const model = createMockModelContext();
    const runtime = createAgentDeskRuntime({
      registerTool: model.registerTool,
      capabilities: [
        defineCapability({
          name: "charge_card",
          description: "Charges a card",
          risk: "WRITE",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
          execute: () => "charged",
        }),
      ],
    });
    await runtime.start();

    const first = await runtime.invoke("invoke_capability", {
      name: "charge_card",
      input: { a: 1, b: 2 },
      idempotency_key: "same",
    });
    const second = await runtime.invoke("invoke_capability", {
      name: "charge_card",
      input: { b: 2, a: 1 },
      idempotency_key: "same",
    });
    expect(second.code).toBeUndefined();
    expect(second.content[0]!.text).toBe(first.content[0]!.text);
  });
});
