import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The claims the interop document makes about what this package pulls in.
 *
 * Only the promises are asserted. Pinning the whole transitive closure would
 * turn every upstream patch release into a CI failure, which teaches people
 * to ignore the check rather than read it.
 */
const packageJson = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
};

const lockfile = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "pnpm-lock.yaml"),
  "utf8",
);

describe("the MCP-B dependency footprint", () => {
  it("ships no runtime dependencies at all", () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it("takes the MCP-B packages as development dependencies only", () => {
    expect(packageJson.devDependencies).toMatchObject({
      "@mcp-b/webmcp-types": expect.any(String),
      "@mcp-b/webmcp-polyfill": expect.any(String),
    });
  });

  it("never pulls the MCP-B packages this project promises to avoid", () => {
    // `@mcp-b/global` is the one that would drag in transports, the TS SDK,
    // and an opt-in to the removed navigator.modelContextTesting.
    for (const excluded of [
      "@mcp-b/global",
      "@mcp-b/transports",
      "@mcp-b/webmcp-ts-sdk",
    ]) {
      expect(lockfile).not.toContain(excluded);
    }
  });

  it("still declares the Node floor the published package supports", () => {
    // The interop tooling needs Node 20 or newer. The published artifact has
    // no runtime dependencies, so its own floor is unaffected by that.
    expect(packageJson.engines?.node).toBe(">=18");
  });
});
