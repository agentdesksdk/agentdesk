import { describe, expect, it } from "vitest";
import { defineCapability } from "../src/capability.ts";
import { rankCapabilities, routeTask } from "../src/router.ts";
import { createAgentDeskRuntime } from "../src/runtime.ts";
import { createMockModelContext } from "./mock-model-context.ts";

// Every name is legal under NAME_RE, and each locale below orders at least one
// pair of them differently from codepoint order. Danish collates a leading
// "aa" as "å", after "z". Estonian and Lithuanian reorder plain letters.
const NAMES = ["zz_task", "hh_task", "gg_task", "ff_task", "ee_task", "ds_task", "aardvark_task"];
const CODEPOINT = [...NAMES].sort();
const LOCALES = ["en", "da", "et", "lt"];
const CTX = { route: "/", state: {} };

function tied() {
  return NAMES.map((name) =>
    defineCapability({
      name,
      description: "Ping something",
      keywords: ["ping"],
      execute: () => ({}),
    }),
  );
}

/**
 * Runs `fn` as if the host default locale were `locale`. In a browser the
 * default is the user's locale, so this is the only way a test on a US
 * machine can observe what a Danish user would be handed.
 */
async function underLocale<T>(locale: string, fn: () => T | Promise<T>): Promise<T> {
  const original = String.prototype.localeCompare;
  const collator = new Intl.Collator(locale);
  String.prototype.localeCompare = function (this: string, that: string) {
    return collator.compare(String(this), String(that));
  };
  try {
    return await fn();
  } finally {
    String.prototype.localeCompare = original;
  }
}

describe("routing order does not depend on the host locale", () => {
  it("has ICU data for the locales the suite relies on, or the suite proves nothing", () => {
    expect(new Intl.Collator("da").compare("aardvark_task", "zz_task")).toBeGreaterThan(0);
    expect(new Intl.Collator("en").compare("aardvark_task", "zz_task")).toBeLessThan(0);
  });

  it("rankCapabilities breaks a tie by codepoint under every locale", async () => {
    for (const locale of LOCALES) {
      const ranked = await underLocale(locale, () => rankCapabilities(tied(), CTX, "ping", 6));
      expect(new Set(ranked.map((r) => r.score)).size, `${locale}: all seven must tie`).toBe(1);
      expect(ranked.map((r) => r.capability.name), locale).toEqual(CODEPOINT.slice(0, 6));
    }
  });

  it("routeTask publishes the same six under every locale, deterministic and hybrid", async () => {
    for (const locale of LOCALES) {
      for (const kind of ["deterministic", "hybrid"] as const) {
        const result = await underLocale(locale, () =>
          routeTask(tied(), { query: "ping", context: CTX, limit: 6 }, { kind }),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.matches.map((m) => m.capability.name), `${locale} ${kind}`).toEqual(
          CODEPOINT.slice(0, 6),
        );
      }
    }
  });

  it("the no-match fallback offers the same five under every locale", async () => {
    for (const locale of LOCALES) {
      const model = createMockModelContext();
      const runtime = createAgentDeskRuntime({
        registerTool: model.registerTool,
        capabilities: tied(),
      });
      await runtime.start();
      const result = (await underLocale(locale, () =>
        model.execute("find_capabilities", { query: "xyzzy" }),
      )) as { content: { text: string }[] };
      const payload = JSON.parse(result.content[0]!.text) as { matches: { name: string }[] };
      expect(payload.matches.map((m) => m.name), locale).toEqual(CODEPOINT.slice(0, 5));
    }
  });
});
