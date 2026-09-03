import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page control must never send a capability call as if it were the
 * agent. Every component source is read; a call to `invoke` is allowed
 * only in the Inspector, and only for `find_capabilities`, which is the
 * routing step the rail exists to show. Approve, reject, reconcile, grant,
 * revoke, and rollback are a person's acts and go through their own APIs.
 */
describe("the demo's components never call a capability as the agent", () => {
  it("contain no call to invoke outside the Inspector's find_capabilities", () => {
    const dir = join(process.cwd(), "src", "components");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(name)) {
        continue;
      }
      const lines = readFileSync(join(dir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/\.invoke\s*\(/.test(line)) {
          return;
        }
        const allowed = name === "Inspector.tsx" && line.includes('"find_capabilities"');
        if (!allowed) {
          offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
