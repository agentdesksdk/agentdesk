// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidenceLink } from "@agentdesk/webmcp";
import { App } from "../src/App.tsx";
import { EvidenceControls } from "../src/components/EvidenceControls.tsx";
import { subscribeProof, type ProofRequest } from "../src/components/evidence.ts";
import { getState, resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

const ORDER = "10428";
const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

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

/** The whole shell: the rail with its receipts, the presence that navigates. */
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

/** The hero refund, approved by a person, so a receipt with evidence exists. */
async function refundThroughApproval() {
  await act(async () => {
    await agentdesk.invoke("refund_shipping", { order_id: ORDER });
  });
  await act(async () => {
    await agentdesk.approve(agentdesk.getSnapshot().pending[0]!.id, HUMAN);
  });
  return agentdesk.queryReceipts({ capability: "refund_shipping" })[0]!;
}

describe("Show me proof", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    resetStore();
    globalThis.localStorage = memoryStorage();
    // jsdom has no scrollIntoView; revealTarget scrolls before it highlights.
    Element.prototype.scrollIntoView ??= () => {};
    // Fast presence: the refund's own narration must not be what moves the
    // page; only the person's press on the control may.
    localStorage.setItem("agentdesk-presence-mode", "fast");
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem("agentdesk-presence-mode");
  });

  it("navigates to the order and reveals the shipping summary anchor, through the proof stream", async () => {
    const view = mountAt("/agentdesk");
    const entry = await refundThroughApproval();
    const shipping = entry.receipt.evidence!.find((l) => l.reveal === "shipping-summary")!;
    expect(shipping).toBeDefined();
    expect(shipping.source).toBe("authored");

    const receipt = view.getByRole("region", { name: "Receipt for Order #10428" });
    const seen: ProofRequest[] = [];
    const unsubscribe = subscribeProof((request) => seen.push(request));
    try {
      const control = within(receipt).getByRole("button", {
        name: new RegExp(`^Show me proof: ${shipping.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      });
      // Still on the overview: the control has not been pressed.
      expect(view.queryByRole("heading", { name: `Order #${ORDER}` })).toBeNull();
      await act(async () => {
        fireEvent.click(control);
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.link).toMatchObject({ route: `/orders/${ORDER}`, reveal: "shipping-summary" });
    } finally {
      unsubscribe();
    }

    // The presence consumer took the request: the page moved and the anchor lit.
    expect(view.getByRole("heading", { name: `Order #${ORDER}` })).toBeDefined();
    await frames(3);
    const anchor = document.querySelector('[data-reveal="shipping-summary"]')!;
    expect(anchor).not.toBeNull();
    expect(anchor.classList.contains("agent-reveal")).toBe(true);
    expect(document.activeElement).toBe(anchor);
  });

  it("offers one control per link on the receipt, each named as the value it proves", async () => {
    const view = mountAt("/agentdesk");
    const entry = await refundThroughApproval();
    const receipt = view.getByRole("region", { name: "Receipt for Order #10428" });
    const controls = within(receipt).getAllByRole("button", { name: /^Show me proof:/ });
    expect(controls).toHaveLength(entry.receipt.evidence!.length);
    for (const control of controls) {
      expect(control.textContent).toMatch(/value/);
      expect(control.textContent).not.toMatch(/page/);
    }
  });

  it("the approval record in the rail carries the same controls", async () => {
    const view = mountAt("/agentdesk");
    await refundThroughApproval();
    const approved = view.getByText("Human approved").closest(".event")!;
    expect(approved).not.toBeNull();
    expect(within(approved as HTMLElement).getAllByRole("button", { name: /^Show me proof:/ }).length).toBeGreaterThan(0);
  });

  it("the Inspector says how many receipts carry proof", async () => {
    const view = mountAt("/agentdesk");
    const line = () => view.container.querySelector("[data-evidence]")?.textContent ?? "";
    expect(line()).toBe("0 of 0");
    await refundThroughApproval();
    expect(line()).toBe("1 of 1");
    expect(getState().orders.find((o) => o.id === ORDER)!.shippingRefunded).toBe(true);
  });
});

describe("a derived link is labelled as the page, an authored one as the value", () => {
  afterEach(cleanup);

  it("says which in the control's text and name", () => {
    const derived: EvidenceLink = {
      label: "Order #10428",
      route: "/orders/10428",
      reveal: "shipping-summary",
      source: "derived",
    };
    const authored: EvidenceLink = {
      label: "Shipping refund on Order #10428",
      route: "/orders/10428",
      reveal: "shipping-summary",
      source: "authored",
    };
    const view = render(<EvidenceControls links={[derived, authored]} />);
    const [first, second] = view.getAllByRole("button", { name: /^Show me proof:/ });
    expect(first!.textContent).toMatch(/page/);
    expect(first!.textContent).not.toMatch(/value/);
    expect(first!.getAttribute("aria-label")).toMatch(/the page/);
    expect(second!.textContent).toMatch(/value/);
    expect(second!.getAttribute("aria-label")).toMatch(/the value/);
  });
});
