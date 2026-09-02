// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryPersistence, type ToolResult } from "@agentdesk/webmcp";
import { App } from "../src/App.tsx";
import { armCommitFault } from "../src/capabilities/staged.ts";
import { describeAttempt } from "../src/components/DurabilityCard.tsx";
import { getState, resetStore } from "../src/data/store.ts";
import { agentdesk, createMeridianRuntime, demoPersistence } from "../src/runtime/agentdesk.ts";
import { demoResolveArtifact } from "../src/runtime/persistence.ts";

const ORDER = "10428";
/** One key for the one call, so the second attempt is the same call. */
const KEY = `durability-${ORDER}`;
const OPERATOR = { id: "operator", name: "Operator", kind: "human" as const };

type Runtime = ReturnType<typeof createMeridianRuntime>;

/** A memory adapter standing in for IndexedDB, with the demo's resolver on it. */
function adapterInMemory() {
  const adapter = memoryPersistence();
  adapter.resolveArtifact = demoResolveArtifact;
  return adapter;
}

/** The call, sent the way a client sends it: by name, with an idempotency key. */
const THE_CALL = { name: "refund_shipping", input: { order_id: ORDER }, idempotency_key: KEY };

/**
 * The operator's mandate. Under a grant the call takes the unapproved path,
 * the one the runtime guards by operation key and by idempotency claim;
 * the record then carries the grant that authorized the write.
 */
function grantRefund(runtime: Runtime) {
  const issued = runtime.grant(
    { capability: "refund_shipping", scope: { order_id: ORDER }, uses: 2, expiresAt: Date.now() + 600_000 },
    OPERATOR,
  );
  expect(issued.ok, JSON.stringify(issued)).toBe(true);
}

/**
 * The interrupted operation: a shipping refund whose commit writes and then
 * throws. The runtime cannot know whether the write landed, so it records
 * an unreconciled outcome instead of a success or a failure.
 */
async function interrupt(runtime: Runtime): Promise<ToolResult> {
  grantRefund(runtime);
  armCommitFault("refund_shipping");
  const done = await runtime.invoke("invoke_capability", THE_CALL);
  expect(done.code, done.content[0]?.text).toBe("EXECUTION_INDETERMINATE");
  return done;
}

describe("an unknown outcome survives a restart of Meridian Ops", () => {
  beforeEach(() => {
    resetStore();
  });

  it("is listed after a fresh start on the same adapter, with what it carried", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);

    const before = first.listUnreconciled();
    expect(before).toHaveLength(1);
    const record = before[0]!;
    expect(record.kind).toBe("commit_indeterminate");
    expect(record.capability).toBe("refund_shipping");
    expect(record.operationKey).toBeDefined();
    expect(record.executedBy).toBeDefined();
    expect(record.grantId).toMatch(/^GRT-/);
    expect(record.changes.map((c) => c.field)).toContain(`Order #${ORDER} shipping refunded`);
    // The fork is not cloneable, so it was written down by the identity the
    // staging adapter gave it, not as two copies of the document.
    const saved = [...adapter.records.values()];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.artifact.kind).toBe("reference");
    expect(JSON.stringify(saved[0]!.artifact)).toContain("refund_shipping");
    await first.stop();

    // A reload: a new runtime, the same store on disk.
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    const after = second.listUnreconciled();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(record.id);
    expect(after[0]!.operationKey).toBe(record.operationKey);
    expect(after[0]!.executedBy).toEqual(record.executedBy);
    expect(after[0]!.grantId).toBe(record.grantId);
    expect(JSON.stringify(after[0]!.changes)).toBe(JSON.stringify(record.changes));
    await second.stop();
  });

  it("refuses the same call again after the restart, with its cause, instead of repeating it", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);
    await first.stop();

    // The reload: a fresh runtime on the same adapter, and the document back
    // at its seed, which is what a page gets.
    resetStore();
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    // Grants do not survive a reload; the operator issues one again, which
    // is what the page's control does. The call then meets the guard.
    grantRefund(second);
    // Refused twice over. While the record is open, its operation key guards
    // the same call: the runtime names the record and executes nothing.
    const id = second.listUnreconciled()[0]!.id;
    const guarded = await second.invoke("invoke_capability", THE_CALL);
    expect(guarded.code, guarded.content[0]?.text).toBe("EXECUTION_INDETERMINATE");
    expect(guarded.data?.record_id).toBe(id);
    expect(second.getSnapshot().pending).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    // Once a person settles the record, the claim on the key still survives,
    // and the same call is refused for that reason, never replayed.
    expect(second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR)).toEqual({ ok: true });
    const again = await second.invoke("invoke_capability", THE_CALL);
    expect(again.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(again.data?.cause).toBe("after_restart");
    expect(String(again.data?.reason)).toMatch(/restart/);
    expect(second.getSnapshot().pending).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    // The card's words for each: the guard's refusal has the same shape as
    // a fresh unknown outcome and is told apart by the record already open.
    expect(describeAttempt(guarded, new Set([id]))).toMatch(/^Refused \(EXECUTION_INDETERMINATE\)/);
    expect(describeAttempt(guarded, new Set([id]))).toContain(id);
    expect(describeAttempt(again)).toMatch(/^Refused \(IDEMPOTENCY_CONFLICT, cause after_restart\)/);
    await second.stop();
  });

  it("reconciles the rehydrated record exactly once, through the rebuilt fork, and the list empties", async () => {
    const adapter = adapterInMemory();
    const first = createMeridianRuntime({ persistence: adapter });
    await first.start();
    await interrupt(first);
    const id = first.listUnreconciled()[0]!.id;
    await first.stop();

    // The reload: the fork is rebuilt from the identity the record kept,
    // against the document as the page finds it, its seed.
    resetStore();
    const second = createMeridianRuntime({ persistence: adapter });
    await second.start();
    const settled = second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR);
    expect(settled).toEqual({ ok: true });
    expect(second.listUnreconciled()).toEqual([]);
    expect(adapter.records.size).toBe(0);
    expect(
      second.getSnapshot().audit.filter((e) => e.kind === "staged_reconciled" && e.recordId === id),
    ).toHaveLength(1);
    const twice = second.reconcile(id, { kind: "commit_not_applied" }, OPERATOR);
    expect(twice.ok).toBe(false);
    await second.stop();
  });
});

/** A Storage the shell can read its presence setting from. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

function mountAt(path: string): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function frames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/** Presses the card's control: one click issues the grant and runs the call. */
async function interruptThroughThePage(view: RenderResult) {
  const card = view.getByRole("region", { name: `Interrupted operations on order #${ORDER}` });
  await act(async () => {
    fireEvent.click(
      within(card).getByRole("button", { name: `Interrupt a shipping refund on order #${ORDER}` }),
    );
  });
  await frames(1);
  expect(agentdesk.getSnapshot().pending, "the call runs under a grant, not an approval").toEqual([]);
  return card;
}

describe("the page shows the record, refuses the repeat, and lets a person settle it", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    for (const record of agentdesk.listUnreconciled()) {
      agentdesk.reconcile(record.id, { kind: "commit_not_applied" }, OPERATOR);
    }
    await demoPersistence.clear();
    resetStore();
    globalThis.localStorage = memoryStorage();
    localStorage.setItem("agentdesk-presence-mode", "fast");
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem("agentdesk-presence-mode");
  });

  it("the Inspector lists the record with what it carried, in text", async () => {
    // jsdom has no IndexedDB, so the page's adapter is the memory one.
    expect(demoPersistence.kind).toBe("memory");
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    await interruptThroughThePage(view);

    const record = agentdesk.listUnreconciled()[0]!;
    expect(record).toBeDefined();
    expect(demoPersistence.records!.size).toBe(1);

    const panel = view.getByRole("region", { name: "Unreconciled outcomes" });
    const text = panel.textContent ?? "";
    expect(text).toContain(record.id);
    expect(text).toContain("refund_shipping");
    expect(text).toContain(record.operationKey!);
    expect(text).toContain(record.executedBy!.name!);
    expect(text).toContain(`Order #${ORDER} shipping refunded`);
    expect(text).toMatch(new RegExp(`grant ${record.grantId}`));
    expect(text).toMatch(/unknown/i);
    expect(view.container.querySelector("[data-unreconciled]")?.textContent).toBe("1");
  });

  it("shows the refusal of the same call again, in words, with its cause", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = await interruptThroughThePage(view);
    await act(async () => {
      fireEvent.click(
        within(card).getByRole("button", { name: `Interrupt a shipping refund on order #${ORDER}` }),
      );
    });
    await frames(1);
    // Refused outright: nothing is pending and nothing ran again.
    expect(agentdesk.getSnapshot().pending).toEqual([]);
    const result = card.querySelector("[data-durability-result]")!.textContent ?? "";
    expect(result).toMatch(/refused/i);
    expect(result).toMatch(/because|cause/i);
    // Whatever code the runtime chose, it is in the words, not only a colour.
    expect(result).toMatch(/[A-Z_]{6,}/);
    expect(agentdesk.listUnreconciled()).toHaveLength(1);
  });

  it("Reconcile settles the record exactly once, announced, and the list empties", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    await interruptThroughThePage(view);
    const record = agentdesk.listUnreconciled()[0]!;
    const panel = view.getByRole("region", { name: "Unreconciled outcomes" });
    // The live region outlives the list, so an announcement about the last
    // record is not unmounted with it.
    const region = view.container.querySelector('[data-unreconciled-status]')!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    await act(async () => {
      fireEvent.click(
        within(panel).getByRole("button", { name: `Reconcile ${record.id}: the write did not land` }),
      );
    });
    expect(agentdesk.listUnreconciled()).toEqual([]);
    expect(demoPersistence.records!.size).toBe(0);
    expect(
      agentdesk.getSnapshot().audit.filter((e) => e.kind === "staged_reconciled" && e.recordId === record.id),
    ).toHaveLength(1);
    expect(view.queryByRole("region", { name: "Unreconciled outcomes" })).toBeNull();
    await frames(3);
    expect(seen.filter(Boolean)).toHaveLength(1);
    expect(seen[0]).toContain(record.id);
  });

  it("Reset Demo leaves nothing persisted and nothing listed", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    await interruptThroughThePage(view);
    expect(demoPersistence.records!.size).toBe(1);
    expect(demoPersistence.claims!.size).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset Demo" }));
    });
    await frames(2);
    expect(agentdesk.listUnreconciled()).toEqual([]);
    expect(demoPersistence.records!.size).toBe(0);
    expect(demoPersistence.claims!.size).toBe(0);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    expect(view.queryByRole("region", { name: "Unreconciled outcomes" })).toBeNull();
  });
});
