import { describe, expect, it } from "vitest";
import { createAgentDeskRuntime, defineCapability, type Capability } from "../src/index.ts";
import { MAX_ROUTED } from "../src/router.ts";
import { createMockModelContext } from "./mock-model-context.ts";

/** Seven capabilities that tie exactly on the hero prompt, so only the budget decides how many route. */
function tied(): Capability[] {
  return Array.from({ length: 7 }, (_, i) =>
    defineCapability({
      name: `rescue_${i}`,
      description: `Rescue step ${i}`,
      domain: "rescue",
      keywords: ["rescue", "kit"],
      execute: () => i,
    }),
  );
}

type Payload = { matches: Array<{ name: string }>; activated_tools: string[]; limit: number; instruction: string };

async function route(options: { routing?: { limit?: number } } = {}) {
  const model = createMockModelContext();
  const runtime = createAgentDeskRuntime({
    registerTool: model.registerTool,
    capabilities: tied(),
    ...options,
  });
  await runtime.start();
  const raw = (await model.execute("find_capabilities", { query: "assemble the rescue kit" })) as {
    content: Array<{ text: string }>;
  };
  const payload = JSON.parse(raw.content[0]!.text) as Payload;
  const snapshot = runtime.getSnapshot();
  const live = snapshot.nativeTools.filter((name) => !snapshot.tombstones.includes(name));
  const task = (await runtime.routeTask("assemble the rescue kit")) as Payload;
  return { payload, live, routed: snapshot.routedTools, task };
}

describe("the routing budget is an option, clamped like every other limit", () => {
  it("routes six of seven tied capabilities at limit 6, and the surface stays at six plus bootstrap", async () => {
    const { payload, live, routed, task } = await route({ routing: { limit: 6 } });

    expect(payload.matches.map((m) => m.name)).toEqual(["rescue_0", "rescue_1", "rescue_2", "rescue_3", "rescue_4", "rescue_5"]);
    expect(payload.activated_tools).toHaveLength(6);
    expect(payload.limit).toBe(6);
    expect(payload.instruction).toMatch(/Up to 6/);
    expect(routed).toHaveLength(6);
    expect(live.length).toBeLessThanOrEqual(4 + MAX_ROUTED);
    expect(task.matches).toHaveLength(6);
  });

  it("clamps a limit above MAX_ROUTED to six", async () => {
    const { payload, routed } = await route({ routing: { limit: 9 } });

    expect(payload.matches).toHaveLength(6);
    expect(payload.limit).toBe(6);
    expect(routed).toHaveLength(6);
  });

  it("routes five with the option absent, as today", async () => {
    const { payload, routed } = await route();

    expect(payload.matches.map((m) => m.name)).toEqual(["rescue_0", "rescue_1", "rescue_2", "rescue_3", "rescue_4"]);
    expect(payload.limit).toBe(5);
    expect(payload.instruction).toMatch(/Up to 5/);
    expect(routed).toHaveLength(5);
  });

  it("routes nothing at a limit of zero or below, rather than dumping the catalog", async () => {
    for (const limit of [0, -1, -6]) {
      const { payload, routed } = await route({ routing: { limit } });
      expect(payload.matches).toEqual([]);
      expect(payload.activated_tools).toEqual([]);
      expect(routed).toEqual([]);
      expect(payload.limit).toBe(0);
    }
  });
});
