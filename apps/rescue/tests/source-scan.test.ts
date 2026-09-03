import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The application must never call its own tools while pretending to be an
 * agent. Every source file under apps/rescue/src is read; a call to invoke,
 * prepare, commit, route, or query the runtime is allowed only in the
 * walkthrough module, which is loaded only behind ?walkthrough=1 and says
 * what it is.
 */
const FORBIDDEN = /\.(invoke|prepare|commitPlan|queryReceipts|routeTask|present)\s*\(/g;
const ALLOWED_FILES = new Set(["walkthrough.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("the page's source never acts as the agent", () => {
  it("contains no call to invoke, prepare, commit, route, or query outside the walkthrough module", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const base = file.split(/[\\/]/).pop()!;
      if (ALLOWED_FILES.has(base)) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(FORBIDDEN)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${base}:${line} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not ship the walkthrough on the normal page: it is loaded only when the URL asks for it", () => {
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    expect(app).not.toMatch(/from "\.\/walkthrough\.ts"/);
    const main = readFileSync(join(process.cwd(), "src", "main.tsx"), "utf8");
    expect(main).toMatch(/walkthrough=1/);
    expect(main).toMatch(/import\("\.\/walkthrough\.ts"\)/);
  });
});

/**
 * complete_rescue runs only when a WebMCP client calls it. Its name is
 * spelled once, where the capability is defined; every other module reaches
 * it through that constant, so a button, a timer, or a script that named it
 * would be visible here. The walkthrough, the one module allowed to call
 * tools, does not know it exists.
 */
describe("the page cannot complete the rescue by itself", () => {
  const root = join(process.cwd(), "src");

  it("spells complete_rescue only in the capability definition", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const base = file.split(/[\\/]/).pop()!;
      if (base === "capabilities.ts") {
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/complete_rescue/g)) {
        offenders.push(`${base}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the walkthrough away from it: no reference to the constant or the capability", () => {
    const walkthrough = readFileSync(join(root, "walkthrough.ts"), "utf8");
    expect(walkthrough).not.toMatch(/COMPLETE_RESCUE|completeRescue|complete_rescue/);
  });

  it("wires no timer or handler to an invocation anywhere in the page", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const base = file.split(/[\\/]/).pop()!;
      if (ALLOWED_FILES.has(base)) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(setTimeout|setInterval|onClick|addEventListener)[\s\S]{0,300}?invoke_capability/g)) {
        offenders.push(`${base}:${text.slice(0, match.index).split("\n").length} ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
