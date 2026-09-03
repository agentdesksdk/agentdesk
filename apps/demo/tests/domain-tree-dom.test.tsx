// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../src/components/Inspector.tsx";
import { resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

const HERO =
  "Find Alice Johnson's unshipped order. If she paid shipping, refund the shipping fee. Do not perform the refund without my approval.";

/**
 * The autonomous routing decision for the hero prompt. vitest runs with
 * apps/demo as its working directory; jsdom gives import.meta.url no file
 * scheme.
 */
const HERO_DECISION = readFileSync(
  join(process.cwd(), "tests", "fixtures", "routing-decision-hero.html"),
  "utf8",
).trimEnd();

function typeQuery(view: RenderResult, text: string) {
  fireEvent.change(view.getByRole("textbox", { name: "Task to route" }), { target: { value: text } });
}

/** The single call: type and press Route, the way the hero flow does. */
async function routeDirectly(view: RenderResult, text: string) {
  typeQuery(view, text);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Route" }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The first of two calls: the person asks for the domains before choosing one. */
async function showDomains(view: RenderResult, text: string) {
  typeQuery(view, text);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Show domains/ }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const report = () => agentdesk.getSnapshot().lastRouting!;

describe("the rail narrows in two calls when a person asks for the domains", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    resetStore();
    await agentdesk.setExposure("routed");
    await agentdesk.setContext({ route: "/", state: {} });
  });

  afterEach(cleanup);

  it("a first-level call renders the tree, each domain with its description and count read from the report", async () => {
    const view = render(<Inspector />);
    expect(view.queryByRole("region", { name: "Domains in the catalog" })).toBeNull();

    await showDomains(view, HERO);

    const domains = report().domains!;
    expect(domains.length).toBeGreaterThan(1);
    expect(report().domain).toBeUndefined();
    const tree = view.getByRole("region", { name: "Domains in the catalog" });
    const rows = tree.querySelectorAll("[data-domain]");
    expect(rows).toHaveLength(domains.length);
    domains.forEach((domain, index) => {
      const row = rows[index]!;
      expect(row.getAttribute("data-domain")).toBe(domain.name);
      const text = row.textContent ?? "";
      expect(text).toContain(domain.name);
      expect(text).toContain(`${domain.capabilities} capabilit`);
      expect(text).toContain(domain.description);
      expect(
        within(row as HTMLElement).getByRole("button", {
          name: `Narrow to ${domain.name}, ${domain.capabilities} capabilities`,
        }),
      ).toBeDefined();
    });
    // The tree's total is the sum of its counts, in text.
    const total = domains.reduce((sum, domain) => sum + domain.capabilities, 0);
    expect(tree.textContent).toContain(`${domains.length} domains`);
    expect(tree.textContent).toContain(`${total} capabilities`);
  });

  it("pressing a domain sends the second call with that domain and ranks inside it, the domain named above the list", async () => {
    const view = render(<Inspector />);
    await showDomains(view, HERO);
    const chosen = report().domains!.find((domain) => domain.name === "billing") ?? report().domains![0]!;
    const seen: string[] = [];
    const region = view.container.querySelector("[role=status]")!;
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: `Narrow to ${chosen.name}, ${chosen.capabilities} capabilities` }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const narrowed = report();
    expect(narrowed.domain).toBe(chosen.name);
    expect(narrowed.query).toBe(HERO);
    expect(narrowed.matches.length).toBeGreaterThan(0);
    const decision = view.container.querySelector(".routing-decision")!;
    expect(decision.textContent).toContain(`Within domain ${chosen.name}`);
    const listed = [...decision.querySelectorAll("[data-match]")].map((li) => li.getAttribute("data-match"));
    expect(listed).toEqual(narrowed.matches.map((match) => match.name));
    // The tree stays, with the chosen domain marked in text, so another can be chosen.
    const row = view.getByRole("region", { name: "Domains in the catalog" }).querySelector(
      `[data-domain="${chosen.name}"]`,
    )!;
    expect(row.textContent).toContain("chosen");
    // The counters move as they do for a single call.
    expect(agentdesk.getSnapshot().routedTools).toEqual(narrowed.activated);
    expect(view.container.querySelector(".reduction .to")?.textContent).toBe(String(narrowed.activated.length));
    // Announced once, naming the domain.
    const spoken = seen.filter(Boolean);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain(chosen.name);
  });

  it("the single call, typed and routed directly, renders exactly today's decision and no tree", async () => {
    const view = render(<Inspector />);
    await routeDirectly(view, HERO);
    expect(report().domain).toBeUndefined();
    expect(view.container.querySelector(".routing-decision")!.outerHTML).toBe(HERO_DECISION);
    expect(view.queryByRole("region", { name: "Domains in the catalog" })).toBeNull();
    expect(view.container.querySelector("[data-domain]")).toBeNull();
  });

  it("routing directly after a narrowed call puts the tree away", async () => {
    const view = render(<Inspector />);
    await showDomains(view, HERO);
    const chosen = report().domains![0]!;
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: `Narrow to ${chosen.name}, ${chosen.capabilities} capabilities` }),
      );
    });
    await routeDirectly(view, HERO);
    expect(report().domain).toBeUndefined();
    expect(view.queryByRole("region", { name: "Domains in the catalog" })).toBeNull();
    expect(view.container.querySelector(".routing-decision")!.outerHTML).toBe(HERO_DECISION);
  });
});
