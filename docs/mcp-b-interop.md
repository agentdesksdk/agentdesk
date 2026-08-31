# MCP-B interoperability

AgentDesk is the governance runtime. MCP-B supplies the types, the polyfill,
and the transport compatibility that make it possible to run AgentDesk
against something closer to a real browser than a hand-written double.

This lane is narrow on purpose. Nothing here changes how AgentDesk routes,
defines capabilities, or gates consequential actions. It answers one
question: does AgentDesk behave correctly against the WebMCP surface an
adopter will actually have.

## What we depend on, and what we do not

`@mcp-b/webmcp-types` and `@mcp-b/webmcp-polyfill` are **development**
dependencies of `@agentdesk/webmcp`. The polyfill's only transitive
dependencies are `@standard-schema/spec` and the types package.

There is no dependency on `@mcp-b/global`, at any tier. That package pulls in
`@mcp-b/transports` and `@mcp-b/webmcp-ts-sdk` and opts into
`navigator.modelContextTesting`, a removed Chromium preview API. AgentDesk
registers into `document.modelContext` and reads nothing else.

`navigator.modelContext` is deprecated in the MCP-B types and unused here.
The polyfill installs it alongside the document member, so a test asserts the
distinction directly: with only the navigator alias present, AgentDesk
reports the surface unsupported rather than picking it up.

## Two generations of `inputSchema`

`RegisteredTool.inputSchema` is `object | string` because both are in the
field at the same time. webmcp#241 made it a JSON Schema object, rolling out
from Chrome 154. Chrome 149 through 153, which is most of the Origin Trial
population, and 154's same-document tools still return the serialized JSON
string it replaced.

A consumer that assumes either arm breaks on the other half of the field, and
a bare `JSON.parse` on the string arm turns a malformed schema into a thrown
exception in the middle of tool discovery. `readInputSchema` branches on the
type, guards the parse, rejects a string that parses to a non-object, and
reports an absent schema as absent rather than as an error.

The polyfill produces the object arm. The string arm is exercised by
re-serializing the schema over the same real registrations rather than by
inventing a tool descriptor.

## `title` is not a nullish fallback

The spec defaults `title` to the empty string when a tool registers none, and
`""` does not fall through `??`. A display name is `tool.title || tool.name`.
A test pins this against the polyfill so the trap stays visible.

## `executeTool` is a Chromium extension

`executeTool` is not a member of the standard `ModelContext`. It is
feature-detected everywhere AgentDesk uses it, and it resolves `null` when a
tool produces no textual output, so `callTool` reports `output: string | null`
rather than claiming a string it may not have.

Input encoding stays as it was. Chrome 152 rejects an object and requires a
pre-serialized JSON string, so `string` is the default and `negotiateEncoding`
is opt-in and restricted to a `readOnlyHint` probe.

## What the polyfill does not do

The polyfill invokes a tool's `execute(input)` with no options argument, so
there is no caller `AbortSignal` to forward. AgentDesk still hands the handler
a signal tied to its own lifecycle rather than passing `undefined`, and
stopping the runtime aborts an in-flight handler. Caller-initiated abort is
therefore untestable against this polyfill, and both halves are pinned by
tests so the distinction does not quietly become an AgentDesk defect in
someone's head.

Retirement replaces a routed tool with a tombstone rather than removing the
name, so `getTools()` still lists it and a client holding a stale list gets a
structured `TOOL_RETIRED` instead of an unknown-tool error. Tests assert
retirement through the runtime snapshot and through the tombstone's response,
not through the name disappearing.

## The extension trust boundary

A browser extension that bridges page tools to an agent sits outside the
page's control, and the boundary between them is the security-relevant part
of this integration.

**Origin-pinned messages are routing, not authentication.** Checking
`event.origin` on a `postMessage`, or pinning a port to an origin, tells you
which frame a message came from. It does not tell you that the sender is
trustworthy, that a human authorized the message, or that the page has not
been compromised by injected script running at that same origin. An origin
match is an addressing fact. Treating it as an authorization fact is how a
page-level XSS becomes an extension-level privilege.

The same applies to `exposedTo`. It restricts which origins may see a tool.
`assertSafeOrigins` rejects wildcards, non-origins, and insecure schemes
because widening visibility is a configuration decision that should fail loudly.
Visibility is still not authorization: a permitted origin can see the tool and
call it, and AgentDesk's own policy gate is what decides whether the call
proceeds.

**Privileged extension actions must remain outside page-controlled code.**
Anything the extension can do that the page cannot, reading other tabs,
touching browser storage beyond the page's own, calling privileged APIs,
carrying a credential the page has no access to, belongs in the extension's
own context and behind its own confirmation. It must never be reachable by a
message the page can synthesize. A page can always synthesize a message that
looks exactly like the one the extension expects, because the page controls
every byte on its side of the boundary.

That is why AgentDesk's approval state machine lives in the runtime rather
than in a transport. An approval is a record that a named human authorized a
specific change, re-checked at execution time. No amount of correct message
routing substitutes for it, and an extension that treats a routed message as
an approved one has removed the only thing standing between an agent and an
irreversible action.

<!-- code-anchors
packages/webmcp/src/webmcp-adapter.ts RegisteredTool ModelContextLike probeFeatures assertSafeOrigins getModelContext
packages/webmcp/src/client.ts readInputSchema createWebMcpClient negotiateEncoding InputEncoding
-->
