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

## Exposure modes

The same runtime serves both experiment arms:

- `routed` (AgentDesk): bootstrap tools + the currently routed working set.
- `flat` (baseline): bootstrap tools + every applicable capability as a
  native tool.

Same catalog, same handlers, same pipeline; only the exposure strategy
differs, which is what makes the `/baseline` vs `/agentdesk` comparison fair.
