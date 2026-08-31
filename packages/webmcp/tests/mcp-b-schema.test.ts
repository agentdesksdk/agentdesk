import { describe, expect, it } from "vitest";
import { readInputSchema } from "../src/index.ts";

/**
 * The helper exists to normalize two browser generations into one safe
 * result, so validity must not depend on which encoding a tool arrived in.
 * An array is not a JSON Schema object in either arm, and an explicit `null`
 * is a value the browser sent rather than a member it omitted.
 */
describe("an input schema is judged the same in both arms", () => {
  const refused = (inputSchema: unknown) =>
    readInputSchema({ name: "probe_tool", inputSchema } as never);

  it("refuses an array as a direct object", () => {
    const result = refused([]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected the array to be refused");
    }
    expect(result.reason).toContain("probe_tool");
  });

  it("refuses the same array serialized", () => {
    expect(refused("[]").ok).toBe(false);
  });

  it("refuses a populated array in both arms alike", () => {
    expect(refused([{ type: "object" }]).ok).toBe(false);
    expect(refused(JSON.stringify([{ type: "object" }])).ok).toBe(false);
  });

  it("refuses an explicit null rather than reading it as omission", () => {
    expect(refused(null).ok).toBe(false);
    expect(refused("null").ok).toBe(false);
  });

  it("refuses a scalar in both arms alike", () => {
    expect(refused(42).ok).toBe(false);
    expect(refused("42").ok).toBe(false);
    expect(refused(true).ok).toBe(false);
  });

  it("still treats an omitted member as absent", () => {
    expect(readInputSchema({ name: "no_args" })).toEqual({
      ok: true,
      schema: undefined,
    });
    expect(refused(undefined)).toEqual({ ok: true, schema: undefined });
  });

  it("accepts a real schema object in both arms alike", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };

    expect(refused(schema)).toEqual({ ok: true, schema });
    expect(refused(JSON.stringify(schema))).toEqual({ ok: true, schema });
  });
});
