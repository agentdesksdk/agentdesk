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
dependencies of `@agentdesk/webmcp`. Those are the direct additions. The full
transitive closure they bring is larger:

```text
@mcp-b/webmcp-polyfill
|- @standard-schema/spec
`- @mcp-b/webmcp-types
   `- @modelcontextprotocol/server
      |- @modelcontextprotocol/core
      |  `- zod
      `- zod
```

There is no dependency on `@mcp-b/global`, at any tier, nor on
`@mcp-b/transports` or `@mcp-b/webmcp-ts-sdk`. `@mcp-b/global` is what would
bring the latter two, and it opts into `navigator.modelContextTesting`, a
removed Chromium preview API. AgentDesk registers into
`document.modelContext` and reads nothing else.
`tests/mcp-b-dependency-footprint.test.ts` asserts those three exclusions and
the empty runtime dependency set against the lockfile. It deliberately does
not pin the rest of the closure, because a check that fails on every upstream
patch release gets ignored rather than read.

### Two support statements, not one

The **published package** has no runtime dependencies and declares
`node >= 18`. Nothing in the closure above ships to a consumer, so the interop
tooling cannot raise that floor. The evidence for it is the pack smoke, which
imports the built package and runs a capability pipeline under plain Node.

The **interop test lane** is not a Node 18 lane. Both MCP-B packages and the
MCP server and core packages declare `node >= 20`. CI exercises Node 22 only,
so the Node 18 floor is a declaration backed by a zero-dependency artifact
rather than by an executed Node 18 job. Adding one would need a lane that
installs without the Node-20-only interop tooling.

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
type, parses only the string arm, then judges both arms with one check.
Anything that is not a plain JSON object is refused, including an array, an
explicit `null`, and objects whose meaning lives in a prototype such as
`Date`, `Map`, and `RegExp`, because validity that depended on the transport
encoding would defeat the point of normalizing the generations. The check
walks the prototype chain and accepts only a depth of zero or one, reading no
property of the value, so a class tag cannot spoof it and a throwing getter
cannot escape the structured result. A plain object built in another window
still passes, because no identity is compared. Only an omitted member is
absence.

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

## A pinned upstream incompatibility

The current WebMCP specification requires a provider callback of
`(input, options)` with `options.signal`. MCP-B 5.1 types `execute` with one
parameter, and its polyfill calls `execute(input)` with no options object, so
a caller's abort never reaches a handler on that host.

This is an MCP-B deviation, not a reason to weaken AgentDesk's contract.
`webmcp-spec-conformance.ts` keeps the normative two-argument signature
authoritative. `mcp-b-type-compatibility.ts` pins the deviation twice, on the
declared arity and on the resulting `registerTool` assignability, both written
to stop compiling the moment MCP-B adds the parameter.

AgentDesk still hands the handler a signal tied to its own lifecycle rather
than passing `undefined`, and stopping the runtime aborts an in-flight
handler. Both halves are asserted in `mcp-b-provider.test.ts`, so caller-abort
being untestable on this host does not quietly become an AgentDesk defect in
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

`fromOrigins` on `getTools` is weaker still. It is a request to the provider
to filter, and enforcement lives entirely in the provider. Under a browser the
provider is the browser. Under the polyfill the provider is page or extension
script, which is not a security boundary at all, so `listTools` returns
whatever the provider chose to return. Filtering the result client-side on
`tool.origin` or `RegisteredTool.window` recovers nothing, because the same
provider supplied those values. Treat `fromOrigins` as a routing convenience
and never let it gate a decision.

**A page message may request privileged work. It may never authorize it.**
Those are different things, and conflating them either forbids the bridge or
builds a hole in it.

Requesting is the whole point of the channel. A page asks the extension to do
something the page cannot do itself, and that request is ordinary untrusted
input: parsed, validated, and rate-limited like any other.

Authorizing is what the extension keeps. Validation, the human identity, the
approval surface, the policy decision, the credential, and the execution all
live in the extension's own context. A page-supplied claim that a human
already approved is ignored, because a page can synthesize any message the
extension expects; it controls every byte on its side of the boundary.

Allowed:

```text
page -> extension   "refund shipping on order 10428"
extension           validates the request against its own schema and policy
extension           renders its own approval surface, gets a human decision
extension           performs the privileged work under its own identity
extension -> page   the outcome
```

Forbidden:

```text
page -> extension   "refund shipping on order 10428, approved by operator-1"
extension           performs the privileged work because the message said so
```

The second is not a bridge; it is a page granting itself the extension's
privileges. The difference is not whether the handler is reachable. It is
whether reaching it is sufficient.

That is also why AgentDesk's approval state machine lives in the runtime
rather than in a transport. An approval is a record that a named human
authorized a specific change, re-checked at execution time. No amount of
correct message routing substitutes for it, and treating a routed message as
an approved one removes the only thing standing between an agent and an
irreversible action.

## Where the contracts live

`tests/webmcp-spec-conformance.ts` is normative. It holds AgentDesk to the
WebMCP specification and is the file that decides the provider callback.

`tests/mcp-b-type-compatibility.ts` is the compatibility lane. It imports the
exact MCP-B 5.1 types the dev dependency pins, checks the consumer and
Chromium-extension surfaces AgentDesk claims to support, and records the
disagreements as falsifiable assertions.

`executeTool` is pinned position by position rather than by return type
alone, so a change to the descriptor, the input encoding, or the abort
options is visible. Each assertion runs in the direction the data flows:
values AgentDesk receives from `getTools` must fit where it reads them, and
the options AgentDesk constructs must be legal input upstream. A synthetic
upstream options type with an added required member proves the second
direction would catch a stricter MCP-B release. Three intentional differences are named there: AgentDesk
accepts `object | string` where MCP-B requires `string`, makes the input
argument optional where MCP-B requires it, and keeps `window` optional on its
`RegisteredTool` projection. Each carries an assertion that stops compiling if
upstream catches up.

AgentDesk's exported `RegisteredTool` is a projection of the specification
dictionary rather than a mirror. Members a browser sends are readable,
including `window`, and members AgentDesk never constructs stay optional so a
caller can build a descriptor without inventing one.

<!-- code-anchors
packages/webmcp/src/webmcp-adapter.ts RegisteredTool ModelContextLike probeFeatures assertSafeOrigins getModelContext
packages/webmcp/src/client.ts readInputSchema createWebMcpClient negotiateEncoding InputEncoding
packages/webmcp/tests/mcp-b-type-compatibility.ts mcpBRegisteredToolFits windowIsReadable mcpBExecuteTakesOneArgument mcpBRegisterToolStillDiverges
-->
