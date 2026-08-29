# AgentDesk architecture

AgentDesk is a capability-virtualization runtime for WebMCP applications. An
application registers a large internal capability catalog once; AgentDesk
decides which small subset is published as native WebMCP tools at any moment,
explains why the rest are unavailable, and gates consequential actions behind
human approval.

```text
React/UI  (observes only)
   │ snapshots / explicit context updates
   ▼
createAgentDeskRuntime({ capabilities })
   ├─ CapabilityCatalog        one entry per capability, name-keyed
   ├─ rankCapabilities         deterministic weighted routing
   ├─ availability             structured reasons + suggested alternatives
   ├─ decidePolicy             READ / WRITE execute, CONSEQUENTIAL needs approval
   ├─ ApprovalManager          pending + resolved action records
   ├─ AuditBus                 append-only in-memory event log
   ▼
ToolSurfaceManager             the only registration manager
   ▼
WebMCP adapter                 the only document.modelContext caller
   ▼
document.modelContext.registerTool(...)
```

## Invariants

1. **UI does not own WebMCP lifecycle.** The runtime is created and started at
   module scope in `apps/demo/src/runtime/agentdesk.ts`; its lifetime is the
   document, not any component. React subscribes to snapshots and calls
   explicit runtime APIs (`setContext`, `setExposure`, `approve`, `reject`).
   No `useEffect` registers or unregisters tools, and unmounting components
   or removing snapshot listeners never tears registrations down (tested).

2. **ToolSurfaceManager is the only runtime registration manager.** It owns
   the `Map<string, { AbortController, fingerprint, bytes }>` of active
   tools, reconciles the desired set against it, aborts retired tools, and
   registers tombstones. A source-scan test enforces that no other module
   calls `adapter.registerTool`.

3. **The adapter is the only `document.modelContext` integration point.**
   `webmcp-adapter.ts` is the single file that touches the browser API. A
   source-scan test enforces this too. Tests and the demo inject a mock
   `registerTool` through the same seam.

4. **Native and compatibility execution share one pipeline.** A native typed
   tool call and `invoke_capability` both resolve through:
   capability lookup → context availability → input pre-flight
   (`checkInput`) → policy → approval if consequential → handler → audit.
   There is exactly one implementation of that pipeline
   (`runCapability` in `runtime.ts`); business logic is never duplicated.

5. **Availability is checked at routing time and again at execution time.**
   `find_capabilities` annotates every match with availability and only
   activates available ones. Invocation re-checks context availability and
   input pre-flight. Approval re-checks both once more before executing, so
   a state change between request and approval fails closed with a
   structured reason (`FAILED_UNAVAILABLE`) instead of mutating stale state.

6. **Consequential actions never block a WebMCP promise.** A CONSEQUENTIAL
   invocation returns `APPROVAL_REQUIRED` with an `approval_id`
   immediately. The human approves or rejects in the page; the agent can
   poll `get_action_status`. No 60-second hanging calls.

7. **Capability routing is application-level virtualization, not removal of
   typed WebMCP tools.** Routed capabilities are registered as real, typed,
   individually-schema'd native tools. The bootstrap surface
   (`get_context`, `find_capabilities`, `invoke_capability`,
   `get_action_status`) is the constant fallback; `invoke_capability` keeps
   stale clients functional and tombstones convert dead calls into
   structured recovery instructions.

8. **No backend.** The demo is a static Vite build. All state is an
   in-browser seeded store; reset restores the pristine seed instantly.

## Module map (`packages/webmcp/src`)

| File | Responsibility |
| --- | --- |
| `capability.ts` | Capability type, `defineCapability`, risk levels, structured availability, `CapabilityUnavailableError` |
| `catalog.ts` | Name-keyed catalog, duplicate rejection |
| `router.ts` | `routeCapability` lookup + `rankCapabilities` weighted scorer |
| `availability.ts` | Availability evaluation helpers |
| `policy.ts` | Risk → allow / approval_required |
| `approval.ts` | `ApprovalManager`: pending actions and resolved records |
| `audit.ts` | `AuditBus` and the audit event union |
| `results.ts` | Structured tool results (`TOOL_RETIRED`, `APPROVAL_REQUIRED`, `CAPABILITY_UNAVAILABLE`) |
| `tool-surface.ts` | Reconciliation, AbortController lifecycle, tombstones, schema-byte accounting |
| `runtime.ts` | The pipeline, bootstrap tools, exposure modes, snapshots |
| `webmcp-adapter.ts` | The only `document.modelContext` touchpoint |

## WebMCP surface coverage

Verified against the spec's `index.bs` IDL. `registerTool`'s second
argument carries `signal` and `exposedTo`; the execute callback's second
argument is `{ signal }`; annotations are exactly `readOnlyHint` and
`untrustedContentHint`; unregistration is abort-only.

| Spec surface | Status |
| --- | --- |
| `registerTool(tool, {signal, exposedTo})` | Implemented; `exposedTo` origins validated at construction |
| Execute callback `{signal}` | Forwarded into handlers as `ctx.signal` |
| Abort-based unregistration | Implemented (ToolSurfaceManager) |
| `name`/`title`/`description`/`inputSchema` | Implemented |
| `readOnlyHint`/`untrustedContentHint` | Implemented; no other keys exist |
| `getTools({fromOrigins})` | Optional client (`createWebMcpClient`) |
| `executeTool(tool, input, {signal})` | Optional client; input serialized (see `testing.md`) |
| `toolchange` | Optional client (`onToolChange`) |
| Permissions Policy `tools` | Documented for deployment; nothing to implement in-page |
| Declarative form tools | Not implemented; the spec section exists but is a TODO |

The consumer-side methods live in `client.ts`, not the runtime, because
AgentDesk's role is being a tool *provider* and control plane. Per-method
browser parity is not guaranteed by the spec, so the client probes with
`probeFeatures()` and returns a structured `{ok: false, reason}` rather
than throwing when a method is absent.

## Execution lifecycle

Every execution gets an `executionId` that correlates its
`execution_started`, `execution_completed`, and `execution_failed` audit
events. The handler receives an `ExecutionContext`: the app context plus
`signal`, `executionId`, and any `idempotencyKey`.

The signal is the client's WebMCP execution signal linked with a runtime
lifecycle signal, so a handler aborts when either the client cancels or the
operator calls `stop()`/`reset()`.

**Abort does not roll anything back.** A signal is a request to stop, not a
transaction boundary. If a handler already issued its write, aborting after
that point cannot unwrite it, and the runtime makes no attempt to
compensate. The obligation sits with the handler, and it is sharpest for
consequential capabilities: check `signal.aborted` immediately before the
mutation, not only at the top.

```ts
execute: async (input, { signal }) => {
  const order = await loadOrder(input.order_id, { signal });
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return commitRefund(order);
},
```

A caller receiving `EXECUTION_CANCELLED` therefore learns that the
execution did not complete cleanly, not that nothing happened. The result
says so, and the audit trail is the place to establish what landed. Those two also end the current *epoch*. An execution that resolves after
its epoch ended cannot write to audit or approval state, so a slow handler
can never repopulate a runtime that was just cleared.

A cancelled execution is visible to its caller. When an execution outlives
its epoch the caller receives `EXECUTION_CANCELLED` rather than a silent
success, because a write that may or may not have landed must not be
reported as completed.

### Idempotency contract

`invoke_capability` accepts an optional `idempotency_key`. The guarantees,
each covered by a test in `tests/audit.test.ts`:

1. **Concurrent duplicates collapse.** The store holds the in-flight
   promise, not just the settled result, so a second call with the same key
   joins the first execution rather than starting another.
2. **Completed replays return the identical result.** The recorded result
   is returned verbatim; the handler does not run again.
3. **Key reuse with different input conflicts.** Input is fingerprinted;
   a mismatch returns `IDEMPOTENCY_CONFLICT` instead of handing back a
   result computed from different arguments.
4. **Keys are scoped per capability.** The slot is `capability:key`, so the
   same key under two capabilities is two independent operations.
5. **Retention is bounded.** 512 entries, evicted oldest-first, cleared by
   `reset()`.

Two limits are deliberate rather than incidental. The store is in-memory,
so it deduplicates retries within a session and not across reloads. And
there is no caller or tenant dimension, because this SDK has no identity
concept and inventing one would be fiction: a multi-tenant deployment must
namespace the key itself (`tenant-42:refund-abc`) or supply its own
`policy` that rejects unnamespaced keys.

## Validation and policy are pluggable

The browser performs no schema validation: the spec types `inputSchema` as
a bare object and hands raw input to the handler. AgentDesk validates at
the boundary before policy, approval, or execution, returning a structured
`VALIDATION_FAILED` with per-field issues. Pass `validate` to swap in Ajv,
Zod, or Standard Schema.

The bundled validator enforces `type` (including `integer`), `required`,
`enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `items`,
and nested `properties` with their own `required` lists. It does not
enforce `oneOf`, `anyOf`, `allOf`, `const`, `$ref`, or
`additionalProperties`.

Unknown keywords are ignored rather than rejected, so a richer schema still
passes rather than failing shut. That is a deliberate trade and it has a
sharp edge: a schema can look validated while a construct in it is inert.
`unsupportedSchemaKeywords(schema)` names every such keyword, which turns
the risk into a one-line test. Assert it is empty for schemas you rely on,
or pass a full validator through the `validate` option.

Because `exposedTo` widens who can call a tool, its origins are validated
when the runtime is constructed rather than at registration. Wildcards,
paths, malformed URLs, and non-loopback `http` origins throw immediately,
since silently dropping an entry would leave the author believing an origin
had been granted access.

`assertSafeOrigins()` is an SDK policy, deliberately stricter than the
spec. The WebMCP algorithm parses a potentially trustworthy URL and stores
its origin, which would accept an input carrying a path. This SDK requires
a bare origin so a typo like `https://agent.example/tools` fails loudly at
startup instead of being silently normalized to something the author did
not write.

Policy is a function, not a table. The default is risk-based
(`riskBasedPolicy`), and `policy` replaces it with anything returning
`allow`, `require_approval`, or `deny` with a reason, which is how limits
("refund <= $500") and tenant rules get expressed without the SDK growing
an RBAC vocabulary. Policy is evaluated twice for a consequential action:
once when the request arrives, and again at approval, so a rule that starts
denying while the action sits pending blocks it.

### Approval evidence is an explicit choice

Every consequential capability declares what the human sees before
approving. `previewChanges` implies `approvalEvidence: "diff"`. A
capability with no enumerable change set must opt in to
`approvalEvidence: "summary"` by hand. `defineCapability` throws when a
consequential capability declares neither, so a missing preview can never
quietly degrade into an empty diff, which is the failure the contract
exists to prevent.

The chosen mode rides on the `APPROVAL_REQUIRED` payload as
`approvalEvidence`, so a caller can tell whether "approved" meant a human
read a field-level diff or only a sentence.

A capability that declares `previewChanges` and throws is refused with
`PREVIEW_UNAVAILABLE` instead of being queued, because approving blind is
worse than failing. A WRITE with a broken preview still executes.

## Previews and receipts

Two distinct artifacts, deliberately not merged:

- **Preview** (`previewChanges`) is evaluated before execution and answers
  "what would this do". It rides on `APPROVAL_REQUIRED` as `will_change`
  and renders as a diff on the approval card. It is advisory; a throwing
  preview is logged and the approval proceeds without one.
- **Receipt** (the `receipt()` result helper) is produced by the handler
  and answers "what did this actually do". It is attached to the tool
  result, the `execution_completed` audit event, and the resolved approval
  record, so `get_action_status` can serve it later.

The receipt is authoritative because only the handler observed both states.
The preview can be wrong if state changes between rendering and approval,
which is exactly why approval re-checks availability and input before
executing.

## Presentation is separate from audit and from execution

Capabilities may declare optional `presentation` hints (`route`, `reveal`,
`message`). The runtime resolves them against the current input and context
and emits `PresentationEvent`s on a dedicated bus
(`runtime.subscribePresentation`), at four points: `intent_routed`,
`capability_started`, `approval_requested`, and
`capability_completed`/`capability_failed`.

Three rules keep this from leaking into the judged path:

1. The runtime never touches the DOM or a router. It emits strings; the
   React layer decides whether to navigate, scroll, or highlight. This is
   the same observation-only boundary as snapshots.
2. Presentation is not audit. Audit is the governance record and must stay
   complete; presentation is transient choreography a headless client
   ignores entirely. They are separate buses with separate types.
3. Presentation listeners are isolated. A throwing listener is logged and
   swallowed; it cannot change a tool result (regression-tested).

`AgentPresence` in the demo consumes this stream, with a guided/fast
toggle. Execution is byte-identical in both modes.

## Hardening contract (from the 2026-08-28 stress test)

Fixed and regression-tested:

- Approval execution atomically claims `PENDING → EXECUTING`; concurrent
  approvals execute exactly once and the loser gets a structured
  already-resolved response.
- Approved input is deep-cloned at request time; mutating the caller's
  object after the human saw the summary cannot change what executes.
- An identical still-pending request is deduplicated instead of creating a
  second approval.
- Snapshot listeners are isolated; an observer exception can never turn a
  committed write into an apparent failure or duplicate a terminal audit
  outcome.
- `start()` only marks the runtime started after successful registration,
  so a transient failure is retryable; `invoke()` before start is rejected.
- `invoke_capability` is not advertised read-only, and routing is
  discoverability, not authorization (any available catalog capability can
  be invoked by name; policy still gates writes and approvals).
- `/` in a capability's routes matches only the exact root route;
  tokenization is Unicode-aware with diacritic folding.
- Discovery queries are truncated to 400 chars before routing and audit;
  the audit log is capped at 1000 events and snapshots are detached copies.
- An explicit exposure-mode switch compacts tombstones instead of keeping
  the retired catalog registered.
- Handlers returning `undefined` yield `"null"`, never a malformed result.

Known limitations:

- Routing is lexical; non-English intent vocabularies rely on
  per-capability keywords, not semantics.
- Idempotency and approval records live in memory. A page reload loses
  pending approvals and dedupe keys; durable storage is not implemented.
- The bundled validator covers the JSON Schema subset this SDK emits
  (types, required, enum, ranges, lengths, pattern, array items, nested
  objects). Unknown keywords are ignored rather than rejected, so exotic
  schemas pass rather than fail shut; call `unsupportedSchemaKeywords()` to
  find them, or supply Ajv via the `validate` option for full coverage.
- Declarative (HTML form) WebMCP tools are not catalogued. The spec does
  reserve a section for them (§4.3 "Declarative WebMCP") and names a
  `synthesize a declarative JSON Schema object` algorithm, but both are
  explicitly TODO and defer to the declarative-api explainer, and the
  explainer states the form-to-schema reduction is itself TBD. There is a
  reserved place in the spec, not a stable shape to build against.
- Multi-client conformance is unverified beyond the clients recorded in
  `testing.md`.

## Exposure modes

The same runtime serves both experiment arms:

- `routed` (AgentDesk): bootstrap tools + the currently routed working set.
- `flat` (baseline): bootstrap tools + every applicable capability as a
  native tool.

Same catalog, same handlers, same pipeline; only the exposure strategy
differs, which is what makes the `/baseline` vs `/agentdesk` comparison fair.
