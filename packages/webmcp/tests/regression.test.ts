import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import {
  defaultValidator,
  unsupportedSchemaKeywords,
} from "../src/validation.ts";
import { createMockModelContext } from "./mock-model-context.ts";

describe("null respects the declared type", () => {
  it("a string-only property rejects null", () => {
    const result = defaultValidator(
      { type: "object", properties: { v: { type: "string" } } },
      { v: null },
    );
    expect(result.valid).toBe(false);
  });

  it("a nullable property accepts null", () => {
    const result = defaultValidator(
      { type: "object", properties: { v: { type: ["string", "null"] } } },
      { v: null },
    );
    expect(result.valid).toBe(true);
  });

  it("a nested string-only property rejects null", () => {
    const result = defaultValidator(
      {
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: { inner: { type: "string" } },
          },
        },
      },
      { outer: { inner: null } },
    );
    expect(result.valid).toBe(false);
  });

  it("a property with no declared type still accepts null", () => {
    const result = defaultValidator(
      { type: "object", properties: { v: { description: "anything" } } },
      { v: null },
    );
    expect(result.valid).toBe(true);
  });
});

describe("nested required matches root required semantics", () => {
  const schema = {
    type: "object" as const,
    properties: {
      outer: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  };

  it("an empty string is present, so nested required passes", () => {
    expect(defaultValidator(schema, { outer: { name: "" } }).valid).toBe(true);
  });

  it("an absent nested property fails", () => {
    expect(defaultValidator(schema, { outer: {} }).valid).toBe(false);
  });

  it("nested minLength owns empty-string rejection", () => {
    const strict = {
      type: "object" as const,
      properties: {
        outer: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    };
    expect(defaultValidator(strict, { outer: { name: "" } }).valid).toBe(false);
  });
});

describe("the reporter flags shapes it cannot enforce", () => {
  it("reports an unrecognized type name", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { v: { type: "date-time" } },
      } as never),
    ).toContain("type");
  });

  it("reports a pattern that does not compile", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: { v: { type: "string", pattern: "([unclosed" } },
      } as never),
    ).toContain("pattern");
  });

  it("accepts recognized types and compilable patterns", () => {
    expect(
      unsupportedSchemaKeywords({
        type: "object",
        properties: {
          a: { type: "string", pattern: "^A[0-9]+$" },
          b: { type: ["integer", "null"] },
        },
      } as never),
    ).toEqual([]);
  });

  it("an unrecognized type is not silently treated as valid", () => {
    const result = defaultValidator(
      { type: "object", properties: { v: { type: "date-time" } } } as never,
      { v: 12345 },
    );
    expect(result.valid).toBe(false);
  });
});

describe("idempotency retention is genuinely bounded", () => {
  it("refuses a new key with a structured result when the store is full of in-flight work", async () => {
    const model = createMockModelContext();
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
            await gate;
            return "charged";
          },
        }),
      ],
    });
    await runtime.start();

    const inFlight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 512; i++) {
      inFlight.push(
        runtime.invoke("invoke_capability", {
          name: "charge_card",
          idempotency_key: `key-${i}`,
        }),
      );
    }
    expect(runtime.getSnapshot().idempotencyEntries).toBe(512);

    const overflow = await runtime.invoke("invoke_capability", {
      name: "charge_card",
      idempotency_key: "one-too-many",
    });
    expect(overflow.code).toBe("IDEMPOTENCY_CAPACITY");
    expect(runtime.getSnapshot().idempotencyEntries).toBeLessThanOrEqual(512);

    release();
    await Promise.all(inFlight);

    // Once entries settle the store accepts new keys again.
    const afterDrain = await runtime.invoke("invoke_capability", {
      name: "charge_card",
      idempotency_key: "after-drain",
    });
    expect(afterDrain.code).toBeUndefined();
    expect(runtime.getSnapshot().idempotencyEntries).toBeLessThanOrEqual(512);
  });

  it("an in-flight retry still joins rather than duplicating", async () => {
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

    const first = runtime.invoke("invoke_capability", {
      name: "charge_card",
      idempotency_key: "k",
    });
    const second = runtime.invoke("invoke_capability", {
      name: "charge_card",
      idempotency_key: "k",
    });
    release();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });
});
