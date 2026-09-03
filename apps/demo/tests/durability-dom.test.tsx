// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolResult } from "@agentdesksdk/webmcp";
import { App } from "../src/App.tsx";
import { getState, resetStore } from "../src/data/store.ts";
import { agentdesk, demoPersistence } from "../src/runtime/agentdesk.ts";

const ORDER = "10428";
const KEY = `durability-${ORDER}`;
const OPERATOR = { id: "operator", name: "Operator", kind: "human" as const };

/** The prompt the client is given; the page shows it and does nothing with it. */
const PROMPT = `Refund the shipping on order ${ORDER} with idempotency key ${KEY}`;

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

const approvalsAsked = () => agentdesk.getSnapshot().audit.filter((e) => e.kind === "approval_requested").length;
const cardOf = (view: RenderResult) => view.getByRole("region", { name: `Interrupted operations on order #${ORDER}` });
const statusOf = (card: HTMLElement) => card.querySelector("[data-agent-status]")?.textContent ?? "";
const stepsOf = (card: HTMLElement) => [...card.querySelectorAll("[data-durability-step]")].map((li) => li.textContent ?? "");

/** The page's own chaos switch: the next commit of refund_shipping writes, then throws. */
async function armTheFault(view: RenderResult): Promise<HTMLElement> {
  const card = cardOf(view);
  const toggle = within(card).getByRole("button", { name: /commit fault/i });
  if (toggle.getAttribute("aria-pressed") !== "true") {
    await act(async () => {
      fireEvent.click(toggle);
    });
  }
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  return card;
}

/**
 * The external client's call, through the mock surface: invoke_capability
 * by name with the idempotency key on the call, the way a WebMCP client
 * sends it. The page is never the caller.
 */
async function clientCall(): Promise<ToolResult> {
  let result: ToolResult | undefined;
  await act(async () => {
    result = await agentdesk.invoke("invoke_capability", {
      name: "refund_shipping",
      input: { order_id: ORDER },
      idempotency_key: KEY,
    });
  });
  await frames(1);
  return result!;
}

/** The person's decision on the approval card, with the activation jsdom lacks injected for the click. */
async function approveOnTheCard(view: RenderResult) {
  const dialog = view.getByRole("alertdialog");
  Object.defineProperty(navigator, "userActivation", { value: { isActive: true }, configurable: true });
  try {
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    });
  } finally {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: false }, configurable: true });
  }
  await frames(1);
}

/** The whole interruption: the fault armed on the page, the client's call, the approval, the unknown outcome. */
async function interrupt(view: RenderResult): Promise<HTMLElement> {
  const card = await armTheFault(view);
  const asked = await clientCall();
  expect(asked.code, asked.content[0]?.text).toBe("APPROVAL_REQUIRED");
  await approveOnTheCard(view);
  expect(agentdesk.getSnapshot().pending).toEqual([]);
  expect(agentdesk.listUnreconciled()).toHaveLength(1);
  return card;
}

describe("the durability card is the page's: it arms the fault, states the prompt, and renders what the runtime recorded", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    for (const record of agentdesk.listUnreconciled()) {
      agentdesk.reconcile(record.id, { kind: "commit_not_applied" }, OPERATOR);
    }
    await demoPersistence.adapter.clear();
    resetStore();
    globalThis.localStorage = memoryStorage();
    localStorage.setItem("agentdesk-presence-mode", "fast");
    Element.prototype.scrollIntoView ??= () => {};
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem("agentdesk-presence-mode");
  });

  it("states the prompt with a copy button, says it is waiting for a WebMCP agent, and has no control that sends the refund", () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = cardOf(view);
    expect(card.textContent).toContain(PROMPT);
    expect(within(card).getByRole("button", { name: /copy/i })).toBeDefined();
    expect(statusOf(card)).toMatch(/Waiting for a WebMCP agent/);
    // The card's only controls: the chaos switch and the copy button. Nothing sends the refund.
    const controls = within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    expect(controls).toHaveLength(2);
    expect(controls[0]).toMatch(/^Commit fault: disarmed/);
    expect(controls[1]).toBe("Copy prompt");
    expect(within(card).getByRole("button", { name: /commit fault/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking every control on the order route with the fault armed creates no pending action and changes no state", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    await armTheFault(view);
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("main button, aside button")];
    for (const button of buttons) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
    await frames(2);
    expect(agentdesk.getSnapshot().pending).toEqual([]);
    expect(approvalsAsked()).toBe(0);
    expect(agentdesk.getSnapshot().audit.filter((e) => e.kind === "capability_invoked")).toEqual([]);
    expect(agentdesk.listUnreconciled()).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
  });

  it("the client's keyed call through the mock surface reaches the approval card, and the card says so from the audit", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = await armTheFault(view);
    const asked = await clientCall();
    expect(asked.code).toBe("APPROVAL_REQUIRED");
    expect(view.getByRole("alertdialog")).toBeDefined();
    expect(agentdesk.getSnapshot().pending).toHaveLength(1);
    const actionId = agentdesk.getSnapshot().pending[0]!.id;
    expect(statusOf(card)).toContain(actionId);
    expect(stepsOf(card).join(" ")).toMatch(/call arrived|approval/i);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
  });

  it("after approval, the fault, and the reload the record is listed and the client's repeat is refused without asking again", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = await interrupt(view);
    const record = agentdesk.listUnreconciled()[0]!;
    expect(record.actionId).toBeDefined();
    expect(await demoPersistence.adapter.loadOpenRecords()).toHaveLength(1);
    expect(statusOf(card)).toContain(record.id);
    expect(statusOf(card)).toMatch(/unknown/i);
    const panel = view.getByRole("region", { name: "Unreconciled outcomes" });
    expect(panel.textContent).toContain(`approval ${record.actionId}, approved by a person`);
    // The commit fault was consumed; the switch reads disarmed again.
    expect(within(card).getByRole("button", { name: /commit fault/i }).getAttribute("aria-pressed")).toBe("false");

    // The reload's half jsdom can stand in for: the document back at its
    // seed while the runtime and its open record stay.
    resetStore();
    const askedBefore = approvalsAsked();
    const repeat = await clientCall();
    expect(repeat.code).toBe("EXECUTION_INDETERMINATE");
    expect(repeat.data?.record_id).toBe(record.id);
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(agentdesk.getSnapshot().pending).toEqual([]);
    expect(approvalsAsked()).toBe(askedBefore);
    // The card renders the refusal from the audit: an invocation the runtime
    // answered with nothing while the record stayed open.
    expect(statusOf(card)).toMatch(/refused/i);
    expect(statusOf(card)).toContain(record.id);
    expect(statusOf(card)).toMatch(/no approval/i);
    expect(agentdesk.listUnreconciled()).toHaveLength(1);
  });

  it("Reconcile settles the record once, announced, and the client's next repeat is refused by the surviving claim", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = await interrupt(view);
    const record = agentdesk.listUnreconciled()[0]!;
    const panel = view.getByRole("region", { name: "Unreconciled outcomes" });
    const region = view.container.querySelector("[data-unreconciled-status]")!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, { childList: true, characterData: true, subtree: true });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: `Reconcile ${record.id}: the write did not land` }));
    });
    expect(agentdesk.listUnreconciled()).toEqual([]);
    expect(view.queryByRole("region", { name: "Unreconciled outcomes" })).toBeNull();
    await frames(3);
    expect(seen.filter(Boolean)).toHaveLength(1);

    resetStore();
    const askedBefore = approvalsAsked();
    const invokedBefore = agentdesk.getSnapshot().audit.filter((e) => e.kind === "capability_invoked").length;
    const statusBefore = statusOf(card);
    const again = await clientCall();
    // On the same runtime the claim on the key answers the repeat with the
    // outcome it recorded. The runtime writes the invocation and nothing
    // after it, and returns from its replay branch without emitting a
    // snapshot, so the page is not told and the card's status stays where
    // it was until the runtime next emits. After a restart the runtime-level
    // tests show the same key refused as IDEMPOTENCY_CONFLICT, cause
    // after_restart. Either way nothing runs and nobody is asked.
    expect(again.code).toBe("EXECUTION_INDETERMINATE");
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(approvalsAsked()).toBe(askedBefore);
    expect(agentdesk.getSnapshot().pending).toEqual([]);
    expect(agentdesk.getSnapshot().audit.filter((e) => e.kind === "capability_invoked")).toHaveLength(invokedBefore + 1);
    expect(statusOf(card)).toBe(statusBefore);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
  });

  it("Reset Demo restores the seed, empties the store, and the card waits again", async () => {
    const view = mountAt(`/agentdesk/orders/${ORDER}`);
    const card = await interrupt(view);
    expect((await demoPersistence.adapter.loadIdempotencyClaims()).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reset Demo" }));
    });
    await frames(2);
    expect(agentdesk.listUnreconciled()).toEqual([]);
    expect(await demoPersistence.adapter.loadOpenRecords()).toEqual([]);
    expect(await demoPersistence.adapter.loadIdempotencyClaims()).toEqual([]);
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(false);
    expect(view.queryByRole("region", { name: "Unreconciled outcomes" })).toBeNull();
    expect(statusOf(card)).toMatch(/Waiting for a WebMCP agent/);
    expect(within(card).getByRole("button", { name: /commit fault/i }).getAttribute("aria-pressed")).toBe("false");
  });
});
