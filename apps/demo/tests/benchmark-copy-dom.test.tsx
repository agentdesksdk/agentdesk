// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Benchmark } from "../src/routes/Benchmark.tsx";

/**
 * The side-by-side panel says what happens when both modes run: the
 * harness approves the refund itself, so no card is shown and nobody
 * clicks. The copy used to say the operator granted it.
 */
describe("the benchmark's side-by-side copy says who approves", () => {
  afterEach(cleanup);

  it("does not say the operator grants the approval, and says the harness approves without a click", () => {
    const view = render(<Benchmark />);
    const panel = view.getByRole("heading", { name: "Same task, both modes" }).parentElement!;
    const text = panel.textContent ?? "";
    expect(text).not.toMatch(/granted by you as the operator/);
    expect(text).toMatch(/harness approves/);
    expect(text).toMatch(/without a click/);
    // The rest of the sentence's facts stay: each arm starts from the seed
    // and the seed is restored.
    expect(text).toMatch(/starts from the demo seed/);
    expect(text).toMatch(/seed is restored/);
  });
});
