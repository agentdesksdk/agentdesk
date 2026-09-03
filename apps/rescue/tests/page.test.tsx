// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { rescue, resetRescue } from "../src/runtime.ts";
import { getState, seed } from "../src/state.ts";

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the rescue page, phase 1", () => {
  beforeEach(async () => {
    await resetRescue();
  });

  afterEach(cleanup);

  it("renders one consolidated plan card, approval commits the plan, and the receipt shows the verified final state", async () => {
    const view = render(<App />);
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Prepare the rescue plan" }));
    });
    await settle();
    expect(getState()).toEqual(seed());

    const plan = rescue.listPlans()[0]!;
    const card = view.getByRole("region", { name: `Plan approval ${plan.id}` });
    expect(card.textContent).toContain("CONSEQUENTIAL");
    expect(within(card).getByRole("list", { name: "Operations in order" }).children).toHaveLength(4);
    const changes = [...within(card).getByRole("list", { name: "Consolidated changes" }).children].map(
      (li) => li.textContent,
    );
    expect(changes).toEqual([
      "Oxygen packs available: 6 → 4",
      "Drone NIA-7: standby → assigned",
      "Dock 3 power: 20% → 65%",
      "Mission AST-10428: draft → launched",
    ]);

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    });
    await settle();

    expect(view.queryByRole("region", { name: `Plan approval ${plan.id}` })).toBeNull();
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("launched");
    expect(view.container.querySelector('[data-field="oxygen"]')?.textContent).toBe("available 4, reserved 2");
    const receipt = view.getByRole("region", { name: `Rescue receipt ${plan.id}` });
    expect(receipt.textContent).toContain("COMMITTED");
    const verified = [...within(receipt).getByRole("list", { name: "Verified changes" }).children].map(
      (li) => li.textContent,
    );
    expect(verified).toEqual([
      "Oxygen packs available: 6 → 4 (VERIFIED)",
      "Drone NIA-7: standby → assigned (VERIFIED)",
      "Dock 3 power: 20% → 65% (VERIFIED)",
      "Mission AST-10428: draft → launched (VERIFIED)",
    ]);
  });

  it("reject leaves the seed and shows no receipt", async () => {
    const view = render(<App />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Prepare the rescue plan" }));
    });
    await settle();
    const plan = rescue.listPlans()[0]!;
    const card = view.getByRole("region", { name: `Plan approval ${plan.id}` });
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    });
    await settle();
    expect(getState()).toEqual(seed());
    expect(view.queryByRole("region", { name: `Plan approval ${plan.id}` })).toBeNull();
    expect(view.container.querySelector('[data-field="mission"]')?.textContent).toBe("draft");
  });
});
