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

Known limitations, deliberate for the hackathon scope:

- No `AbortSignal` forwarding into capability handlers; cancellation of an
  in-flight handler is not supported.
- `stop()`/`reset()` do not await in-flight executions; a slow handler that
  resolves after reset can append late audit events. No execution epochs.
- No idempotency keys on approval creation or write capabilities.
- Input schemas are descriptive; enforcement is per-capability
  (`checkInput`, handler guards), not compiled JSON-schema validation.
- The npm package exports TypeScript source for the workspace bundler; no
  built `dist/` artifacts are published. Consume it inside the monorepo.
- Routing is lexical; non-English intent vocabularies rely on
  per-capability keywords, not semantics.

## Exposure modes

The same runtime serves both experiment arms:

- `routed` (AgentDesk): bootstrap tools + the currently routed working set.
- `flat` (baseline): bootstrap tools + every applicable capability as a
  native tool.

Same catalog, same handlers, same pipeline; only the exposure strategy
differs, which is what makes the `/baseline` vs `/agentdesk` comparison fair.
