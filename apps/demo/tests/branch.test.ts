import { describe, expect, it } from "vitest";
import { deriveChanges, mergeBranch } from "../src/data/branch.ts";
import { buildSeed } from "../src/data/seed.ts";
import type { Branch, DemoState } from "../src/data/types.ts";

const edit = (state: DemoState, fn: (draft: DemoState) => void): DemoState => {
  const next = structuredClone(state);
  fn(next);
  return next;
};

const order = (state: DemoState, id: string) =>
  state.orders.find((candidate) => candidate.id === id)!;

const branchOf = (base: DemoState, fn: (draft: DemoState) => void): Branch => ({
  base,
  head: edit(base, fn),
  at: 0,
});

describe("deriving a diff from a fork", () => {
  it("names the field, the old value, and the new value", () => {
    const base = buildSeed();
    const { base: from, head } = branchOf(base, (draft) => {
      order(draft, "10428").shippingRefunded = true;
    });

    expect(deriveChanges(from, head)).toEqual([
      { field: "Order #10428 shipping refunded", before: false, after: true },
    ]);
  });

  it("reports an appended note as its text rather than a length change", () => {
    const base = buildSeed();
    const { base: from, head } = branchOf(base, (draft) => {
      order(draft, "10428").notes.push("Refunded shipping.");
    });

    expect(deriveChanges(from, head)).toEqual([
      {
        field: "Order #10428 notes added",
        before: null,
        after: "Refunded shipping.",
      },
    ]);
  });

  it("reports a created row once instead of field by field", () => {
    const base = buildSeed();
    const { base: from, head } = branchOf(base, (draft) => {
      draft.credits.push({
        id: "CR-4001",
        customerId: "C-1001",
        amount: 18,
        reason: "Shipping refund",
        issuedAt: "2026-08-29T00:00:00.000Z",
      });
    });

    expect(deriveChanges(from, head)).toEqual([
      { field: "Credit CR-4001", before: null, after: "added" },
    ]);
  });
});

describe("merging an agent branch", () => {
  it("keeps both sides when the agent and the human touch one order", () => {
    const base = buildSeed();
    const human = edit(base, (draft) => {
      order(draft, "10428").carrier = "DHL";
      order(draft, "10428").notes.push("Customer called.");
    });
    const branch = branchOf(base, (draft) => {
      order(draft, "10428").shippingRefunded = true;
      order(draft, "10428").notes.push("Refunded shipping.");
    });

    const { state, conflicts } = mergeBranch(branch, human);

    expect(conflicts).toEqual([]);
    expect(order(state, "10428").carrier).toBe("DHL");
    expect(order(state, "10428").shippingRefunded).toBe(true);
    expect(order(state, "10428").notes).toContain("Customer called.");
    expect(order(state, "10428").notes).toContain("Refunded shipping.");
  });

  it("keeps the human's value and reports the field when both write it", () => {
    const base = buildSeed();
    const human = edit(base, (draft) => {
      order(draft, "10428").status = "on_hold";
    });
    const branch = branchOf(base, (draft) => {
      order(draft, "10428").status = "cancelled";
    });

    const { state, conflicts } = mergeBranch(branch, human);

    expect(order(state, "10428").status).toBe("on_hold");
    expect(conflicts).toEqual([
      {
        collection: "orders",
        key: "10428",
        field: "status",
        human: "on_hold",
        agent: "cancelled",
      },
    ]);
  });

  it("carries rows the agent created and leaves an untouched branch inert", () => {
    const base = buildSeed();
    const human = edit(base, (draft) => {
      draft.orders.push({ ...order(base, "10428"), id: "99999" });
    });
    const branch = branchOf(base, (draft) => {
      draft.credits.push({
        id: "CR-9001",
        customerId: "C-1001",
        amount: 18,
        reason: "Shipping refund",
        issuedAt: "2026-08-29T00:00:00.000Z",
      });
    });

    const { state, conflicts } = mergeBranch(branch, human);

    expect(conflicts).toEqual([]);
    expect(state.credits.some((credit) => credit.id === "CR-9001")).toBe(true);
    expect(state.orders.some((candidate) => candidate.id === "99999")).toBe(true);
    expect(
      mergeBranch({ base, head: base, at: 0 }, human).state.orders,
    ).toHaveLength(human.orders.length);
  });
});
