// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../src/components/Inspector.tsx";
import { Benchmark } from "../src/routes/Benchmark.tsx";
import { resetStore } from "../src/data/store.ts";
import { agentdesk } from "../src/runtime/agentdesk.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };

/** Where the shell collapses to one column. 375 is well inside it. */
const NARROW_BREAKPOINT = 720;

/** vitest runs each package from its own directory, so this is apps/demo. */
const stylesheet = () => readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");

/** The bodies of every `@media (max-width: <=N px)` block, brace-matched. */
function narrowBlocks(css: string, maxWidth: number): string[] {
  const out: string[] = [];
  const open = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(css)) !== null) {
    if (Number(match[1]) > maxWidth) {
      continue;
    }
    let depth = 1;
    let i = open.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(css.slice(open.lastIndex, i - 1));
  }
  return out;
}

/** The declarations of one selector inside a block, or undefined. */
function rule(block: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|[}\\s,])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m").exec(block);
  return found?.[1];
}

/**
 * jsdom lays nothing out, so the no-horizontal-scroll rule at 375px cannot be
 * measured here; it is measured in the browser pass. What can be pinned is
 * that the stylesheet carries a narrow breakpoint at all, and that inside it
 * the three things that overflowed at 375 are addressed: the three-column
 * shell, the sidebar as a column, and the approval overlay fixed at 380px.
 */
describe("the shell collapses below a narrow breakpoint", () => {
  it("has a max-width block at or under the breakpoint", () => {
    expect(narrowBlocks(stylesheet(), NARROW_BREAKPOINT).length).toBeGreaterThan(0);
  });

  it("puts the shell in one column, with the sidebar as a row", () => {
    const block = narrowBlocks(stylesheet(), NARROW_BREAKPOINT).join("\n");
    const shell = rule(block, ".shell");
    expect(shell).toBeDefined();
    const columns = /grid-template-columns:\s*([^;]+);/.exec(shell!)?.[1]?.trim();
    // One track, whatever it is called; not the 208px/190px sidebar column.
    expect(columns).toBeDefined();
    expect(columns!.split(/\s+(?![^(]*\))/)).toHaveLength(1);
    expect(shell).not.toMatch(/\d+px\s+minmax/);
    const nav = rule(block, ".sidebar nav");
    expect(nav).toMatch(/flex-direction:\s*row/);
  });

  it("turns the approval overlay into a full-width sheet instead of a 380px box", () => {
    const block = narrowBlocks(stylesheet(), NARROW_BREAKPOINT).join("\n");
    const overlay = rule(block, ".approval-overlay");
    expect(overlay).toBeDefined();
    expect(overlay).toMatch(/left:\s*0/);
    expect(overlay).toMatch(/right:\s*0/);
    expect(overlay).toMatch(/width:\s*auto/);
  });
});

describe("wide tables scroll inside their own container", () => {
  afterEach(cleanup);

  it("both benchmark tables sit in a table-scroll container the stylesheet scrolls horizontally", () => {
    const view = render(
      <MemoryRouter initialEntries={["/agentdesk/benchmark"]}>
        <Routes>
          <Route path="/:mode/benchmark" element={<Benchmark />} />
        </Routes>
      </MemoryRouter>,
    );
    const tables = [...view.container.querySelectorAll("table")];
    expect(tables.length).toBe(2);
    for (const table of tables) {
      expect(table.parentElement?.classList.contains("table-scroll")).toBe(true);
    }
    expect(rule(stylesheet(), ".table-scroll")).toMatch(/overflow-x:\s*auto/);
  });
});

describe("the authority line wraps between phrases, never inside one", () => {
  beforeEach(async () => {
    await agentdesk.reset();
    resetStore();
  });

  afterEach(cleanup);

  it("renders each phrase of a clause as its own no-wrap span, with the text unchanged", async () => {
    const view = render(<Inspector />);
    const line = () => view.container.querySelector("[data-authority]")!;
    expect(line().textContent).toBe("read + propose");

    await act(async () => {
      agentdesk.grant(
        {
          capability: "refund_shipping",
          scope: { order_id: "10428" },
          uses: 2,
          expiresAt: Date.now() + 60_000,
        },
        HUMAN,
      );
    });
    expect(line().textContent).toBe("refund shipping ≤ 2 uses on order 10428");
    const parts = [...line().querySelectorAll(".nowrap")].map((el) => el.textContent);
    expect(parts).toEqual(["refund shipping", "≤ 2 uses", "on order 10428"]);
    expect(rule(stylesheet(), ".nowrap")).toMatch(/white-space:\s*nowrap/);
  });
});
