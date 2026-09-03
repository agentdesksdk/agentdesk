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
