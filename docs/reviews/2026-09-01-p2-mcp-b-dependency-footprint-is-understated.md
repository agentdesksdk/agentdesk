# P2: the MCP-B dependency footprint and Node floor are understated

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `a0c5f23` (PR #13)

## Finding

The interop document calls the polyfill's two direct dependencies its only
transitive dependencies. The lockfile shows a larger closure:

```text
@mcp-b/webmcp-polyfill
|- @standard-schema/spec
`- @mcp-b/webmcp-types
   `- @modelcontextprotocol/server
      |- @modelcontextprotocol/core
      |  `- zod
      `- zod
```

The useful claim that `@mcp-b/global`, `@mcp-b/transports`, and
`@mcp-b/webmcp-ts-sdk` are absent is true. The claim that only the types and
Standard Schema packages are pulled is not.

Both MCP-B packages and the MCP server/core packages declare Node 20 or newer,
while `@agentdesksdk/webmcp` advertises Node 18 or newer. Because these are
development-only dependencies, the published SDK can still retain an empty
runtime dependency set and support Node 18. The repository's new interop test
lane, however, is not a Node 18 lane, and CI currently exercises only Node 22.
The report does not distinguish those two support statements.

Affected code: `docs/mcp-b-interop.md:12-21`,
`packages/webmcp/package.json:39-59`, `pnpm-lock.yaml:1373-1391`, and
`.github/workflows/ci.yml:14-16`.

## Required correction

Describe direct dependencies and the full transitive closure separately.
State explicitly that the MCP-B interop tests require Node 20+, while the
published AgentDesk runtime remains dependency-free and declares Node 18.
Keep the precise and verified exclusion of `@mcp-b/global`, transports, and
the MCP-B TypeScript SDK.

If Node 18 remains a supported runtime, add a minimum-version pack/import
lane that does not install or execute the Node-20-only interop tooling, or
otherwise document what evidence supports the Node 18 claim.

## Regression requirement

Add a lightweight lockfile/dependency assertion for the packages AgentDesk
specifically promises not to pull. Do not hard-code the entire closure unless
the project intends every transitive package change to fail CI.

## Resolution

`docs/mcp-b-interop.md` now prints the direct additions and the full
transitive closure separately, including `@modelcontextprotocol/server`,
`@modelcontextprotocol/core`, and `zod`. The verified exclusion of
`@mcp-b/global`, `@mcp-b/transports`, and `@mcp-b/webmcp-ts-sdk` is kept and
is now asserted against the lockfile by
`packages/webmcp/tests/mcp-b-dependency-footprint.test.ts`, alongside the empty
runtime dependency set and the declared Node floor. The rest of the closure is
deliberately not pinned, per the caution in this finding.

The two support statements are stated separately. The published package has no
runtime dependencies and declares `node >= 18`, with the pack smoke as the
evidence: it imports the built artifact and runs a capability pipeline under
plain Node. The interop test lane is not a Node 18 lane, because both MCP-B
packages and the MCP server and core packages declare `node >= 20`, and CI
exercises Node 22 only. The document says plainly that the Node 18 floor is a
declaration backed by a zero-dependency artifact rather than by an executed
Node 18 job, and what adding one would require.

No CI change is included. `.github/workflows/ci.yml` is outside what this
branch owns, and adding a Node 18 lane is a separate decision about what the
project wants to promise.
