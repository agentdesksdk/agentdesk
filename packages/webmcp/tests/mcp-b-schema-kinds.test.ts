// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readInputSchema } from "../src/index.ts";

/**
 * A schema is data. Anything whose identity lives in its prototype is not a
 * JSON Schema object, and the direct arm must say so for the same reason the
 * serialized arm already does: a verdict that changes with the encoding
 * defeats the point of normalizing the two browser generations.
 */
const verdict = (inputSchema: unknown) =>
  readInputSchema({ name: "probe_tool", inputSchema } as never);

const frames: HTMLIFrameElement[] = [];

/** A plain object from another realm, which is what a cross-window tool sends. */
function foreignPlainObject(source: Record<string, unknown>): object {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const foreign = frame.contentWindow as unknown as {
    eval: (code: string) => unknown;
  };
  const made = foreign.eval("({})") as Record<string, unknown>;
  Object.assign(made, source);
  return made;
}

afterEach(() => {
  for (const frame of frames.splice(0)) {
    frame.remove();
  }
});

describe("only a plain JSON object is a schema", () => {
  for (const [label, make] of [
    ["a Date", () => new Date()],
    ["a Map", () => new Map()],
    ["a Set", () => new Set()],
    ["a RegExp", () => /schema/],
    ["an Error", () => new Error("nope")],
  ] as const) {
    it(`refuses ${label}`, () => {
      const result = verdict(make());

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected ${label} to be refused`);
      }
      expect(result.reason).toContain("probe_tool");
    });
  }

  it("gives a Date the same verdict in both arms", () => {
    // The asymmetry the review reproduced. A Date serializes to a JSON
    // string, so the string arm always refused it while the direct arm did
    // not.
    const date = new Date();

    expect(verdict(date).ok).toBe(false);
    expect(verdict(JSON.stringify(date)).ok).toBe(false);
  });

  it("still accepts what an exotic actually serializes to", () => {
    // A Map serializes to `{}`, which is a legal, if empty, schema object.
    // Refusing that would be refusing a different value than the one the
    // direct arm rejects.
    expect(JSON.stringify(new Map())).toBe("{}");
    expect(verdict("{}")).toEqual({ ok: true, schema: {} });
    expect(verdict({})).toEqual({ ok: true, schema: {} });
  });

  it("still accepts a plain object built in another realm", () => {
    const schema = foreignPlainObject({
      type: "object",
      properties: { subject: { type: "string" } },
    });

    const result = verdict(schema);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.schema).toBe(schema);
  });

  it("still accepts an object with no prototype", () => {
    const schema = Object.assign(Object.create(null), { type: "object" });

    expect(verdict(schema).ok).toBe(true);
  });
});

describe("the plain-object check cannot be spoofed or made to throw", () => {
  it("refuses a Date that claims to be an Object", () => {
    // `Object.prototype.toString` reads Symbol.toStringTag, so a class tag is
    // whatever the value says it is.
    const disguised = new Date();
    Object.defineProperty(disguised, Symbol.toStringTag, {
      value: "Object",
      configurable: true,
    });

    expect(verdict(disguised).ok).toBe(false);
  });

  it("ignores a throwing class-tag getter and accepts the plain object", () => {
    const hostile = { type: "object" };
    Object.defineProperty(hostile, Symbol.toStringTag, {
      get() {
        throw new Error("tag getter exploded");
      },
      configurable: true,
    });

    // The value is a plain object, so the answer is yes. What matters is that
    // reaching it never reads the tag: a predicate that did would throw out
    // of a function whose contract is a structured result.
    const result = verdict(hostile);

    expect(result).toEqual({ ok: true, schema: hostile });
  });

  it("refuses a Map that claims to be an Object", () => {
    const disguised = new Map();
    Object.defineProperty(disguised, Symbol.toStringTag, {
      value: "Object",
      configurable: true,
    });

    expect(verdict(disguised).ok).toBe(false);
  });
});

describe("a hostile prototype chain is refused, not propagated", () => {
  it("refuses a proxy whose getPrototypeOf trap throws", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap exploded");
        },
      },
    );

    expect(verdict(hostile).ok).toBe(false);
  });

  it("refuses a proxy wrapping a Date", () => {
    const wrapped = new Proxy(new Date(), {});

    expect(verdict(wrapped).ok).toBe(false);
  });
});
