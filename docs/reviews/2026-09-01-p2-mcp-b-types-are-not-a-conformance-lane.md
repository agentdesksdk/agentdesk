# P2: the MCP-B types are installed but never form a conformance lane

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `a0c5f23` (PR #13)

## Finding

PR #13 adds `@mcp-b/webmcp-types` as a direct development dependency and the
interop document says MCP-B supplies the types, but no source, test, or
compile-time probe imports that package. The runtime tests exercise the
polyfill through AgentDesk's own hand-written `ModelContextLike`, so they prove
runtime behavior and nothing about type compatibility. The existing
`webmcp-spec-conformance.ts` still checks only the separate
`webmcp-types@0.1.5` globals.

Two concrete differences are invisible to the new lane:

- Both the current WebMCP IDL and MCP-B 5.1 require
  `RegisteredTool.window: Window`; AgentDesk's exported `RegisteredTool` omits
  it while saying it mirrors the specification. Consumers of `fromOrigins`
  cannot access the owning window without a cast.
- MCP-B 5.1 types `ModelContextTool.execute` with one argument, while the
  current WebMCP specification requires `(input, options)` and a required
  `options.signal`. The polyfill follows its own one-argument type. This is an
  upstream MCP-B deviation worth pinning explicitly, not evidence that
  AgentDesk should weaken its normative provider contract.

The `as never` registration in `mcp-b-client.test.ts` further hides rather
than characterizes the boundary. A future MCP-B upgrade can change its types
without any AgentDesk check failing.

Affected code: `packages/webmcp/package.json:53-59`,
`packages/webmcp/src/webmcp-adapter.ts:52-75`,
`packages/webmcp/tests/mcp-b-client.test.ts:20-31`, and
`packages/webmcp/tests/webmcp-spec-conformance.ts:1-37`.

## Required correction

Choose and encode the contract instead of leaving the dependency decorative:

1. Keep the normative WebMCP conformance lane authoritative for the provider
   callback, including `ToolExecuteCallbackOptions.signal`.
2. Add a compile-time MCP-B compatibility file that imports the exact 5.1
   types and checks the consumer and extension surfaces AgentDesk claims to
   support.
3. Pin known upstream differences deliberately so a later MCP-B fix produces
   a useful compile failure rather than silently changing the boundary.
4. Either expose `RegisteredTool.window`, or rename and document the exported
   type as an intentional projection rather than saying it mirrors the full
   dictionary.

If no MCP-B type compatibility is intended, remove the redundant direct types
dependency and correct the documentation instead.

## Regression requirement

The new compile-only test must fail when the MCP-B `RegisteredTool` or Chrome
extension signatures drift. It must also encode the current execute-options
disagreement without making MCP-B's one-argument callback the normative
AgentDesk provider type.

## Resolution

`packages/webmcp/tests/mcp-b-type-compatibility.ts` imports the exact MCP-B
5.1 types and is compiled by `pnpm typecheck`. It checks that MCP-B's
`RegisteredTool` and `getTools` fit the shapes AgentDesk reads them through,
that AgentDesk's register options are legal MCP-B inputs, that both
`inputSchema` arms survive, and that the Chromium `executeTool` result type
admits `null`.

`webmcp-spec-conformance.ts` stays normative for the provider callback. The
MCP-B disagreement is pinned rather than absorbed, in two falsifiable
assertions: the declared one-argument arity of `ModelContextTool.execute`, and
the resulting non-assignability of MCP-B's `registerTool` to AgentDesk's. Both
stop compiling when MCP-B adds the options parameter, which is the intended
signal to revisit the runtime half recorded in `mcp-b-provider.test.ts`.

`RegisteredTool.window` is exposed, so a consumer filtering by `fromOrigins`
reaches the owning window without a cast. The type's doc comment now describes
it as a projection of the specification dictionary rather than a mirror, and
says why the members AgentDesk never constructs stay optional. Removing
`window` again makes the compatibility lane fail to compile, which was checked.

## Follow-up verification

The new lane imports MCP-B and catches the provider arity and `window` drift,
but it does not meet the record's Chrome-extension regression requirement.
`executeToolResultFits` reduces both methods to
`Awaited<ReturnType<...>>`. A change to MCP-B's `executeTool` tool parameter,
input encoding, or abort-options parameter still compiles as long as the
return remains `Promise<string | null>`.

That is signature drift by construction, and it affects the method
`createWebMcpClient.callTool` invokes. Keep this record open until the lane
compares the parameter tuples as well as the return. Where AgentDesk
intentionally accepts a wider input encoding than MCP-B, pin that difference
explicitly instead of projecting the parameters away.

## Resolution, second pass

`executeTool` was reduced to its return type, so a change to the descriptor,
the input encoding, or the abort options would have passed unnoticed. Every
position is pinned separately now.

Arity is asserted on both sides, as the unions optional trailing parameters
produce, so an added or dropped position is visible. The descriptor position
asserts MCP-B's fits where AgentDesk reads it, which is the direction that
matters because values come from `getTools`. The abort options assert against
`ChromeModelContextExecuteToolOptions`, and that its `signal` is an
`AbortSignal`.

Two intentional widenings are named rather than averaged away, each with a
`StillDiverges` assertion that stops compiling if upstream catches up. MCP-B
types the payload `string` while AgentDesk accepts `object | string`, because
`negotiateEncoding` can settle on the object encoding. MCP-B requires the
input argument while AgentDesk's is optional, because `callTool` defaults it
for a tool that takes none. A third records that AgentDesk's `RegisteredTool`
projection keeps `window` optional, so a hand-built descriptor is legal here
and would not satisfy MCP-B.

Verified load-bearing by deleting the options position from
`ModelContextLike.executeTool`, which fails three assertions in this file.
