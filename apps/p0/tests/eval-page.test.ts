import { describe, expect, it } from "vitest";
import { defineCapability, receipt, unavailable } from "@agentdesk/webmcp";
import { ARMS } from "../../../scripts/evals/arms.mjs";
import { buildCatalog } from "../../../scripts/evals/catalog.mjs";
import { armFromSearch, createEvalRuntime, EVAL_TASKS } from "../eval-page.ts";

const BOOTSTRAP = new Set([
  "find_capabilities",
  "invoke_capability",
  "get_context",
  "get_action_status",
]);

const HUMAN = { id: "evaluator", name: "Evaluator", kind: "human" as const };

/** The names the eval runner itself builds, read straight from catalog.mjs. */
function expectedNames(): Set<string> {
  const { capabilities } = buildCatalog(defineCapability, receipt, unavailable) as {
    capabilities: Array<{ name: string }>;
  };
  return new Set(capabilities.map((capability) => capability.name));
}

/**
 * The page exists so a person can drive the eval's task set through a real
 * client. That only measures anything if the page mounts the catalog the
 * eval runs, so the names are compared as sets against buildCatalog rather
 * than against a list the page could have copied.
 */
describe("the eval page mounts the eval catalog", () => {
  it("resolves every catalog name through the runtime and nothing else", async () => {
    const expected = expectedNames();
    expect(expected.size).toBeGreaterThan(6);

    const registered = new Set<string>();
    const { runtime } = createEvalRuntime({
      arm: "baseline",
      registerTool: async (tool) => {
        registered.add(tool.name);
      },
    });
    await runtime.start();

    expect(runtime.getSnapshot().catalogSize).toBe(expected.size);
    const mounted = new Set([...registered].filter((name) => !BOOTSTRAP.has(name)));
    for (const name of mounted) {
      expect(expected).toContain(name);
    }
    // Flat exposure registers what is available at seed; a capability whose
    // availability refuses every input is still mounted, and invoking it by
    // name must reach it rather than fall off the catalog.
    for (const name of expected) {
      const result = await runtime.invoke(name, {});
      expect(result.content[0]?.text ?? "").not.toContain("unknown capability");
    }
    expect(new Set(runtime.getSnapshot().available)).toEqual(mounted);
    await runtime.stop();
  });

  it("the routed arm mounts the same catalog behind the bootstrap tools", async () => {
    const expected = expectedNames();
    const registered = new Set<string>();
    const { runtime } = createEvalRuntime({
      arm: "agentdesk",
      registerTool: async (tool) => {
        registered.add(tool.name);
      },
    });
    await runtime.start();
    expect(registered).toEqual(BOOTSTRAP);
    expect(runtime.getSnapshot().catalogSize).toBe(expected.size);
    await runtime.stop();
  });

  it("reset returns the store to seed the way the runner does between tasks", async () => {
    const first = createEvalRuntime({ arm: "baseline", registerTool: async () => {} });
    await first.runtime.start();
    const attempt = await first.runtime.invoke("refund_shipping", { order_id: "10428" });
    expect(attempt.code).toBe("APPROVAL_REQUIRED");
    await first.runtime.approve(first.runtime.getSnapshot().pending[0]!.id, HUMAN);
    expect([...first.store.refunded]).toEqual(["10428"]);
    expect(first.store.log).toEqual(["refund_shipping"]);
    expect(first.runtime.queryReceipts()).toHaveLength(1);

    // The catalog's own guard sees the write: a second refund on the same
    // order is refused at the runtime, not only visible in the store.
    const again = await first.runtime.invoke("refund_shipping", { order_id: "10428" });
    expect(again.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(again.data?.reasonCode).toBe("ALREADY_REFUNDED");
    expect([...first.store.refunded]).toEqual(["10428"]);
    expect(first.store.log).toEqual(["refund_shipping"]);
    await first.runtime.stop();

    // A fresh catalog carries a fresh store, exactly what run.mjs builds per
    // task, so nothing the last task wrote can decide the next task's result.
    const second = createEvalRuntime({ arm: "baseline", registerTool: async () => {} });
    await second.runtime.start();
    expect(second.store).not.toBe(first.store);
    expect(second.store.refunded.size).toBe(0);
    expect(second.store.log).toEqual([]);
    expect(second.runtime.queryReceipts()).toHaveLength(0);
    expect(second.runtime.getSnapshot().pending).toEqual([]);
    await second.runtime.stop();
  });
});

describe("both arms are reachable from the URL", () => {
  it("maps ?arm= to the exposures arms.mjs declares, and nothing else", () => {
    expect(armFromSearch("?arm=baseline")).toEqual(ARMS.baseline);
    expect(armFromSearch("?arm=agentdesk")).toEqual(ARMS.agentdesk);
    expect(armFromSearch("?arm=baseline")?.exposure).toBe("flat");
    expect(armFromSearch("?arm=agentdesk")?.exposure).toBe("routed");
    expect(armFromSearch("")).toBeNull();
    expect(armFromSearch("?arm=routed")).toBeNull();
    expect(armFromSearch("?arm=")).toBeNull();
  });

  it("lists the eval's own task set for the person driving it", () => {
    expect(EVAL_TASKS.length).toBe(6);
    expect(EVAL_TASKS.map((task) => task.id)).toContain("refund-shipping-happy");
    for (const task of EVAL_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(task.terminalTool.length).toBeGreaterThan(0);
    }
  });
});
