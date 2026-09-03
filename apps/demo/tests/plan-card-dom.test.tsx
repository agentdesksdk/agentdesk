// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanCards } from "../src/components/PlanCards.tsx";
import { resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

describe("plan approval card", () => {
  beforeEach(async () => {
    resetStore();
    await agentdesk.reset();
    await agentdesk.start();
  });

  afterEach(() => cleanup());

  it("lets the page-local human approve a plan prepared through WebMCP", async () => {
    const prepared = await agentdesk.invoke("invoke_capability", {
      name: "prepare_plan",
      input: {
        summary: "Inspect order shipping",
        operations: [
          { capability: "get_order_shipping", input: { order_id: "10428" } },
        ],
      },
    });
    const planId = String(prepared.data?.plan_id);
    render(<PlanCards />);
    expect(screen.getByText("Plan approval required")).toBeTruthy();

    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: true },
      configurable: true,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    });

    expect(agentdesk.getPlan(planId)?.status).toBe("APPROVED");
  });
});
