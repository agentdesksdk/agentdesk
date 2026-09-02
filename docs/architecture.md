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
   ├─ availability             structured reasons + a checked repair
   ├─ decidePolicy             READ / WRITE execute, CONSEQUENTIAL needs approval
   ├─ protocol                 one result shape: changed, possible, blocked, repair, evidence
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
   capability lookup → routability (policy asked with no input) → context
   availability → input pre-flight (`checkInput`) → validation → policy with
   the validated input → approval if consequential → handler → audit.
   There is exactly one implementation of that pipeline
   (`runCapability` in `runtime.ts`); business logic is never duplicated.

5. **Availability is checked at routing time and again at execution time,
   and routing and results share one eligibility.** `find_capabilities`
   annotates every match with availability and only activates available
   ones. Invocation re-checks context availability and input pre-flight.
   Approval re-checks both once more before executing, so a state change
   between request and approval fails closed with a structured reason
   (`FAILED_UNAVAILABLE`) instead of mutating stale state. A capability
   policy denies is a different case from one that is unavailable: it is
   invisible, on every path, while an unavailable one is visible with its
   reason. The one predicate that decides (`routable`) is what routing ranks
   over, what the native surface registers from, and what every result's
   `nowPossible` and `blockedCapabilities` are computed through, so no
   result can name a capability routing would not offer.

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
| `plan.ts` | `PlanStore`, `OperationPlan`, plan statuses, `Actor`, `VerificationResult` |
| `receipts.ts` | `ReceiptStore`, the queryable history of what changed, with the executing actor, plan, and rollback state |
| `protocol.ts` | The result protocol: `Repair`, `Evidence`, `Situation`, and the `ResultProtocol` union every terminal result conforms to |
| `grants.ts` | Scoped authority grants: the `Grant` state union, scope parsing and matching, and the `GrantStore` that spends uses |
| `results.ts` | Structured tool results (`TOOL_RETIRED`, `APPROVAL_REQUIRED`, `CAPABILITY_UNAVAILABLE`, `completed`), each built from a situation |
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
| `getTools({fromOrigins})` | Optional client (`createWebMcpClient`); advisory, enforced by the provider and never a gate (see `mcp-b-interop.md`) |
| `executeTool(tool, input, {signal})` | Optional client; input serialized (see `testing.md`) |
| `toolchange` | Optional client (`onToolChange`) |
| Permissions Policy `tools` | Documented for deployment; nothing to implement in-page |
| Declarative form tools | Not implemented; the spec section exists but is a TODO |

The consumer-side methods live in `client.ts`, not the runtime, because
AgentDesk's role is being a tool *provider* and control plane. Per-method
browser parity is not guaranteed by the spec, so the client probes with
`probeFeatures()` and returns a structured `{ok: false, reason}` rather
than throwing when a method is absent.

## The result protocol

Every terminal result the runtime hands an agent answers five questions:
what changed, what is now possible, what stays blocked, which capability
repairs the situation, and what evidence proves the answer. The shape is
one type, `ResultProtocol` in `protocol.ts`, discriminated by the `status`
every payload already carries.

```ts
type ResultProtocol =
  | { status: "COMPLETED"; changes: Change[]; nowPossible; blockedCapabilities; evidence }
  | { status: "APPROVAL_REQUIRED"; nowPossible; blockedCapabilities; evidence }
  | { status: "INDETERMINATE"; changes: Change[]; nowPossible; blockedCapabilities; evidence }
  | { status: RefusalStatus; reason: string; repair?: Repair; nowPossible; blockedCapabilities; evidence };
```

A refusal looks like this on the wire, here for a refund whose order is not
yet verified:

```json
{
  "status": "CAPABILITY_UNAVAILABLE",
  "capability": "refund_shipping",
  "reasonCode": "NOT_VERIFIED",
  "reason": "Order is not identity-verified",
  "nowPossible": ["issue_credit", "verify_customer_identity"],
  "blockedCapabilities": ["refund_shipping"],
  "repair": { "capability": "verify_customer_identity", "input": { "customerId": "CUS-104" } },
  "suggestedCapability": "verify_customer_identity",
  "evidence": []
}
```

The variants are spelled out so the combinations that cannot happen are
not constructible. A success carries `changes` and never a `repair`; a
refusal carries a `reason` and may carry a `repair`, and never `changes`.
The builders in `results.ts` enforce it at compile time: `completed`,
`approvalRequired`, and `executionIndeterminate` take a `Settled` situation
whose `repair` is typed `never`, and every refusal builder takes a
`Refusal`. Handing a refusal's situation to a success builder does not
compile, which is the guarantee that a result can never say both "done"
and "here is how to fix it".

**Denied is invisible; unavailable is visible.** The two lists are computed
by `partition` through `routable`, the same predicate `find_capabilities`
ranks over and `desiredNative` registers from. `routable` asks policy with
no input, because routing has none; a policy that denies on missing input
hides the capability, and a throwing policy denies. A denied capability is
therefore absent from a routing report, from `getTools()` in either
exposure, from `nowPossible` and `blockedCapabilities`, and from `repair`,
and a denied capability invoked by name answers `POLICY_DENIED` before its
availability is read, so a guessed name learns nothing about its state.
Under a deny-all policy every one of those fields is empty on every path.
An unavailable capability, by contrast, is listed in `blockedCapabilities`
and carries its `reasonCode` and `reason` on its own refusal and on its
routing match.

**A repair is the author's claim, checked.** `Unavailability.repair` names
a capability and the input to call it with. The runtime keeps it only when
that capability exists, is routable, and is available right now
(`visibleRepair`), so a repair is always an instruction the agent can
follow. An unavailable repair is dropped and listed as blocked instead; a
denied one is dropped and not listed. The builders never read the author's
repair directly: `capabilityUnavailable` takes only the code and the
sentence, and the repair reaches it on the situation the runtime built.
`suggestedCapability` no longer exists on `Unavailability`; it is derived
from `repair.capability` on the way out, for one release, and
`unavailable(code, reason, "name")` still means `{ capability: "name" }`.
Two refusals carry a repair the runtime chose rather than the author:
`VALIDATION_FAILED` names the same capability, because the fix is the same
call with the arguments corrected, and `STAGED_PROPOSAL_MISSING` names the
same capability with the input the human already saw, because the fix is a
new proposal for a new approval. A tombstone names `find_capabilities`.

**The lists are a neighbourhood, not a catalog.** `situationFor` collects
the capability itself, its author's repair, one hop of the relationship
graph in both directions, and what the last routing offered, then
partitions those names. That is where "what now" lives: the step this one
needed, the step it just unblocked, the alternative its author named, and
the working set the agent already holds. It is bounded by the routing
budget plus a capability's declared edges, so a result in flat exposure
does not list seventy-eight names. The routing report's own lists are the
matches it offered plus the repairs those matches named. Bootstrap tools
are in neither list, because they are the constant surface.

**Evidence is a runtime-issued id.** A completed write names its stored
receipt and its execution; a pending approval names the approval; a
refusal at approval time names the approval it refused; an indeterminate
write names the record a human reconciles; a refusal thrown from inside a
handler names the execution that threw. A refusal before any execution has
none. The kinds are `receipt`, `execution`, `approval`, and `record`.

**A plain value keeps its content.** A handler that returns a `receipt()`
envelope gets the full payload in `content` and `data` alike. A handler
that returns a bare value keeps that value as its `content` text, byte for
byte what it was before this protocol, and carries the answers in `data`
with `changes: []`, because consumers parse that text as the bare value
today. A handler that builds its own `ToolResult` keeps it. The result is
assembled after the receipt is stored, because it names the receipt's id;
that is safe only because the value is reduced to plain data once, before
the commit, so the assembly can neither throw nor read a handler's getter
twice.

Plan outcomes (`OperationOutcome`), `get_action_status`, and a handler
exception surfaced as a bare `errorResult` are not in this protocol yet.

## Scoped authority grants

A person approves a bounded mandate once, and the runtime spends it one
execution at a time instead of asking for an approval on every call.

```ts
const issued = runtime.grant(
  {
    capability: "refund_shipping",
    scope: { customerId: "CUS-104", maxAmount: 25 },
    uses: 3,
    expiresAt: "2026-09-03T00:00:00Z",
  },
  { id: "operator-1", name: "Amein", kind: "human" },
);
// issued.ok && issued.grant.state === "live" && issued.grant.remaining === 3
runtime.revokeGrant(issued.grant.id, { id: "operator-1", kind: "human" });
```

**The shape makes the illegal states unconstructible.** A `Grant` carries
its id, the capability, the parsed `scope`, the `uses` granted, the human
`issuedBy`, `issuedAt`, and `expiresAt`, and is in exactly one of four
states: `live` with a `remaining` count, `exhausted` with `remaining: 0`
and `exhaustedAt`, `expired` with `expiredAt`, or `revoked` with
`revokedAt` and the human `revokedBy`. A terminal state is a distinct
shape rather than a live grant with a flag, and only a `LiveGrant` can
authorize an execution. Records are frozen, so a holder cannot add a use to
a grant it was shown. Expiry settles lazily: a live grant past its expiry
becomes `expired` the next time anything reads it.

**Scope is per field, exact for identity and bounded for numbers, and
never a wildcard.** The request's `scope` is written per input field and
parsed into `ScopeRule`s: a primitive is an `exact` rule on that field, and
a key of the form `maxAmount` or `minAmount` is a `bound` on the field
`amount`. Every rule must hold against the call input, and a field the
input does not carry fails its rule, so a scope can only ever narrow what a
call may do. A bound and an exact value on one field contradict each other
and the request is refused; so is a non-primitive value, a non-positive use
count, an expiry that is not a timestamp, or an expiry already passed.

**A grant never widens policy.** `runCapability` consults grants after the
policy decision and before the approval gate, and only when policy said
`require_approval`. Under `deny` nothing is consulted and nothing executes,
and the native surface is unchanged because grants have no bearing on
`routable`. Under `allow` a grant is never consulted, spends nothing, and
records nothing. Where policy would ask for an approval, the first live
grant whose scope covers the call stands in for the person this once, and
the execution runs down the same unapproved path a WRITE takes.

**The use is spent at the execution claim, before the first await.**
`GrantStore.spend` is synchronous and runs after the idempotency claim and
after staging succeeded, at the point the runtime commits to executing. A
concurrent second call runs its own consult only after the first has
suspended, so it sees the decremented count; two calls against one
remaining use start exactly one execution. An idempotent replay returned
before that line, so it spends nothing. A use once spent is never returned,
because the handler may already be running and a mandate counts dispatches.
The receipt carries `grantId`, `queryReceipts({ grantId })` finds every
write one grant authorized, and `execution_started` names the grant.

**A grant that does not apply changes nothing.** A grant on record that
does not cover the call, a spent grant, a revoked one, or an expired one
means the grant does not apply, and the call takes the path it always had:
`APPROVAL_REQUIRED`, with a person deciding. Refusing instead would let a
mandate for one customer make another customer's refund un-approvable. The
information is kept: the approval result carries `grant`, the grant the call
was checked against and why it did not apply, as
`{ id, outcome: "exhausted" | "expired" | "revoked" }` or
`{ id, outcome: "missing_field" | "out_of_scope", field }` or
`{ id, outcome: "over_bound", field, max }` /
`{ id, outcome: "under_bound", field, min }`. It is in the result protocol:
`nowPossible` includes every capability holding a live grant, so the answer
can point at a sibling the person already authorized, and there is no
`repair`, because the fix is a person deciding rather than a capability the
agent can call. When several grants exist the considered one is the one
whose state a person can act on first: a live grant the call fell outside
of, then an exhausted one, then a revoked one, then an expired one.

**Revoke is immediate.** `revokeGrant` moves a live grant to `revoked` with
the human who did it, and the next use goes to a person with
`outcome: "revoked"` on the result. An execution that already spent its use
is untouched, because its use was spent before its handler ran. Only a live grant can be revoked; revoking an
exhausted or expired one is refused with a reason rather than rewriting
its history.

**Only a person can mint or revoke.** `grant` and `revokeGrant` resolve
their identity through `adoptHumanActor`, which is `adoptActor` followed by
`isHumanActor`. A malformed identity throws the same `TypeError` the
ambient actor would, and an agent identity throws too, rather than being
handed a reason: an agent asking for a mandate is the thing a grant exists
to prevent, and the ambient actor is usually the agent, so relying on it
throws as well. Request-shape problems and an unknown capability return
`{ ok: false, reason }`. `listGrants`, `getGrant`, and `getSnapshot().grants`
hand out the frozen records in every state; `reset` clears them.

**Audit.** Four kinds carry the grant lifecycle, and `execution_started`
and the receipt name the grant that authorized a write. `grant_issued`
carries the human `actor`, `uses`, and `expiresAt`. `grant_applied` is
written at the spend, before the `execution_started` it precedes, with the
uses `remaining`. `grant_not_applied` carries the `outcome` and, for a
scope outcome, the `field`, so the audit says what the mandate stopped at
even though the call went on to a person. `grant_revoked` carries the human
`actor` and the uses left unspent. The two human-only kinds type `actor` as
`HumanActor`, like `plan_approved`. The demo's activity panel renders all
four; its exhaustive `switch` is why the kinds and the panel cases land in
one change.

Grants apply to a direct invocation. `approve()` executes an approval a
person gave for that call, and a plan carries its own approval, so neither
consults grants.

## An approval is bound to a state digest

An approval authorizes an exact state, not an action name. Every preview
carries `stateVersion`, a digest the runtime computes from the state the
preview was derived from, and commit re-derives it from current state and
refuses on mismatch without writing.

```json
{ "status": "APPROVAL_STALE", "code": "APPROVAL_STALE",
  "capability": "cancel_order", "approval_id": "APR-1001",
  "reasonCode": "APPROVAL_STALE", "requiresNewPreview": true,
  "stateVersion": { "expected": "sv-3f2a91c07b1d4e66", "observed": "sv-9c04e2aa51f7b380" },
  "repair": { "capability": "cancel_order", "input": { "order_id": "10428" } },
  "nowPossible": ["cancel_order"], "blockedCapabilities": [],
  "evidence": [{ "kind": "approval", "id": "APR-1001" }] }
```

**What the digest covers.** `stateDigest` in `staging.ts` digests each
change's `field` and its `before` value, in field order, and nothing else.
That is the set of facts a person read when they approved: a write to
anything outside it leaves the digest intact, and a write to anything inside
it changes it. Digesting the whole store instead would fire a stale
approval on every unrelated write, and a stale approval that fires on
unrelated writes teaches people to re-approve without reading. `after` is
not covered: a capability whose output depends on a clock or a counter
produces a different `after` from the same state, and that is not drift.
What the person authorized is a change *from* this state, so the runtime
re-derives the change at commit and compares the from.

**One digest function.** A single approval and a plan operation share
`stateDigest` and share `currentDigest`, the runtime's re-derivation, so
the two cannot drift apart on what "the same state" means. At preview time
the digest is computed from the preview the adapter or the author just
derived. At commit time `currentDigest` derives it again the same way: a
fresh fork for a staged capability, released as soon as it has been read,
or the author's `previewChanges` for a direct one. Only the reviewed
artifact ever lands; the probe is never committed. A probe that cannot be
derived yields no digest and counts as moved, because a state that cannot
be read back is not one anyone approved.

**The runtime computes it; nothing else can.** Nothing an adapter's `diff`
or an author's `previewChanges` returns reaches the digest except `field`
and `before`. A `stateVersion` a capability or an adapter hands in on a
change is ignored, and the result's `stateVersion` is written by the
runtime after everything else, so the value on the preview is always the
runtime's own. The digest binds state, not output, and that is the edge of
the guarantee. A staged capability commits the reviewed artifact itself, so
there is no gap between what was shown and what lands. A direct capability
re-derives at execution, so the value that lands is whatever the handler
produces then; an author's `previewChanges` must report in `before`
everything the handler reads for the digest to mean what a person thinks it
means, because a rule or a table the handler consults without reporting it
is outside the digest and can move without a stale refusal. A summary-only
approval has no preview to derive from and carries no `stateVersion`; its
approval is not bound to state, because there is no state it showed.

**Where it fires.** `approve()` checks after policy and availability and
before the staged artifact is taken, so a stale approval releases its
artifact, resolves the action `FAILED_UNAVAILABLE` with reason code
`APPROVAL_STALE`, and returns `APPROVAL_STALE` in the result protocol with
`requiresNewPreview: true`, the expected and observed digests, and the
same request as the repair, because the fix is a new preview of current
state for a person to look at. `commitPlan` runs the identical check per
operation, after the operations before it have landed, so the probe forks
from the state that operation was reviewed against; the operation whose
base moved is `SKIPPED` with an `APPROVAL_STALE` detail and the rest of
the plan proceeds. This is the generalization of the plan's revision drift
check to every staged approval: the optional whole-store `revision`
provider remains as a coarse fence a plan may pin, and the digest is the
fine one every preview carries.

**A grant-authorized execution is digest-free by construction.** It has no
preview: a live grant stands in for the approval and the call takes the
unapproved execution path, so there is no `stateVersion` on its result and
nothing to check. The person bound their authority to a scope and a use
count when they issued the grant, not to a state.

## The agent sees a projection

The human sees the whole application. The agent sees a role-shaped
projection of it, declared once as `agentView({ state, actor })` and
applied by the runtime on its side of the boundary to everything that
crosses to the agent, so a capability cannot skip it.

```ts
const runtime = createAgentDeskRuntime({
  capabilities,
  agentView: ({ state, actor }) => {
    const { paymentToken: _hidden, ...visible } = state;
    return actor?.kind === "human" ? state : visible;
  },
});
```

**Where it is declared.** On the runtime, and optionally on a capability.
The runtime's view is the outer bound. It runs first, so a capability's
`agentView` sees only what the runtime's let through and can only narrow
it, and it runs again after, so a capability's view that puts a key back
does not get it across. A capability with no view of its own gets the
runtime's. A runtime with no view declared behaves exactly as it did
before this section existed.

**What it applies to.** Tool results, including a handler's return value,
the receipt on a completed result, and the `changes` on an indeterminate
one; the approval preview on `APPROVAL_REQUIRED`; the routing report;
`get_context`, including the application state it carries and whatever
`describeContext` produces; `get_action_status`, including the stored
result; and tombstone results. The view is applied to every plain record
at every depth of a value and to every element of an array, so a handler
that nests state does not slip it past a view written for the root. That
is why a view has to be a subtraction over whatever it is handed: the
runtime hands it every record that crosses, not only the root state, and a
view that keeps a fixed set of keys would empty a handler's result. A
change crosses only if the field it names would cross: each change is
rebuilt as the one-field state it describes and passed through the view,
and a field the view removes takes its change with it, before and after.

**A hidden value is withheld wherever it appears.** A key view cannot see
a handler that copies a hidden value under another name, or an author who
writes it into a receipt's `entity` or a refusal's `reason`. So every
result leaves through one seam, `crossing`, which projects the current
state, takes every string that was in the state and is not in the
projection as a hidden value, and withholds each occurrence in the
result's text and data, in any key and inside any sentence. This is what
makes "never appears" true rather than "not under that key". There are
two tiers. Every hidden string is withheld by whole-value equality, at any
depth under any key, which keeps the re-label case closed for a value of
any length. Inside free text only a hidden string of at least eight
characters is matched, longest first, because a shorter one is too common
a substring: a hidden `US` would tear `STATUS` and `USB-C Dock`, a hidden
`ok` would mangle `token`. So a secret shorter than eight characters is
protected structurally and by whole value, not inside free text, and an
author who needs a short value protected inside sentences must not write
it into sentences. Only strings are matched: a hidden number or boolean is
too short and too common to withhold by value without withholding the rest
of the result, so a secret has to be a string to get this protection. The
cost that remains is that a long hidden value which also legitimately
appears elsewhere is withheld there too.

**Exception text is withheld when a view is declared.** An exception
message is written by whoever threw, and it can carry a field the view
excludes, so a handler's error text, a preview's error, an indeterminate
commit's detail, and a failed availability check's message stay on the
human side, in the audit record and the unreconciled record, and the agent
gets the fact and the execution to ask about. A reason an author wrote
deliberately with `unavailable()` still crosses, subject to the hidden
value check. With no view declared the runtime is what it was.

**A throwing view fails closed and is audited.** The refusal is
`VIEW_UNAVAILABLE`, in the result protocol, with reason code
`AGENT_VIEW_FAILED` and a `capability_unavailable` audit event carrying the
same code. It carries `completed`, so an agent whose write landed before
its view failed is told not to retry it, with the execution and the receipt
as evidence. Nothing the view would have projected is shown; the raw value
never stands in for a failed projection. A view that fails while a preview
is being prepared queues nothing.

**The human side is not projected.** `getSnapshot()`, `subscribeAudit`,
`queryReceipts`, `listUnreconciled`, the pending action a person approves,
and the presentation stream carry the whole application. Only what crosses
to the agent is projected.

## A receipt says where its proof can be seen

"Show me proof" is a place in the application: a page to navigate to and
an element to highlight. A receipt carries that as `evidence`, a list of
`EvidenceLink`s, and the same links ride on the result protocol's
`evidence` list as `{ kind: "link", label, route, reveal }`, so the answer
is identical whether it is read off a result or off a stored receipt.

```ts
type AuthoredEvidenceLink = {
  label: string;   // what a person will see: "Shipping line on the invoice"
  route: string;   // a page in the application, starting with "/"
  reveal?: string; // an opaque anchor the application registered, never a selector
};
type EvidenceLink = AuthoredEvidenceLink & { source: "authored" | "derived" };
```

**The type says which is which.** `source` is set by the runtime when it
settles the receipt, never by the capability: an author's link is stamped
`authored` and anything an author put in `source` is overwritten. An
authored link is the value: the author knew where the changed value lives
and pointed at it. A derived link is page-level: a presentation hint names
the write's page and its anchor, not necessarily the field that changed. A
consequential capability should author its links, and the roadmap gate
that a link resolves to the value that changed applies to authored ones.

The shape is exactly what the demo's `reveal.ts` needs to navigate and
highlight, and nothing more. `reveal` is the same registered token the
presentation stream already carries, so the page that highlights a
completed write highlights its proof the same way.

**Authored wins; otherwise derived; otherwise empty.** A capability may
author `evidence` on its `receipt()`, and `receipt()` refuses a malformed
link at authoring time, because a link a page cannot follow is the author's
mistake and the author is the one who can fix it. When nothing is authored
the runtime derives one link from the capability's `presentation.route`
and `reveal`, with the receipt's `entity` as the label: those hints already
name the page and the anchor the demo navigates to for the write, so they
are the proof's address too. Nothing is guessed from the entity text or the
field names. A capability with no route declared has no derived link, and
its receipt carries an empty list rather than a link that goes nowhere.
The list is settled once, in `runExecution`, before the receipt reaches
the audit event, the store, or the result, so all three carry the same
links.

**A link crosses through the agent view like every other field.** Its
`reveal` is treated as a field name and passed through the view the way a
change is; its route is checked segment by segment against the hidden
values and then through the same two tiers as any text; its label too. A
link that names a hidden route or a hidden field is dropped from the
agent's copy rather than withheld with a hole in it, because a route with a
hole navigates nowhere. The stored receipt keeps every link for the person.

The demo half, a "show me proof" control on the receipt that follows the
link, is the demo lane's item.

## Execution lifecycle

Every execution gets an `executionId` that correlates its
`execution_started`, `execution_completed`, and `execution_failed` audit
events. It also lands on the stored receipt and on the plan's
`OperationOutcome`, so a planned operation, its receipt, and its audit
records all point at each other. Those three audit events also carry the
acting `actor`. The handler receives an `ExecutionContext`: the app
context plus `signal`, `executionId`, and any `idempotencyKey`.

**One invocation resolves its actor exactly once, at its earliest point.**
`runCapability` reads the ambient actor into a local const at its first
statement, before any presentation event and before the first audit append,
and threads that value through `capability_started`, `approval_requested`,
and the execution. `runExecution` does not read the ambient actor at all. It
takes the acting identity as a required `ExecutionOptions` field, so a new
entry point that forgets to resolve one fails to compile rather than falling
back to an ambient read.

The boundary has to be the invocation, not the execution. Presentation
listeners dispatch synchronously, so a listener reacting to
`capability_started` runs to completion before the execution begins and can
call `setActor` in between. Capturing at the execution would let a read-only
observer change the provenance of the write it is observing. Every other
entry point applies the same rule at its own earliest point. `approve()`
resolves the acting identity before it claims the pending action, `prepare`
resolves `requestedBy` before any `previewChanges` callback runs, and
`rollback` resolves at the moment its claim succeeds.

The signal is the client's WebMCP execution signal linked with a runtime
lifecycle signal, so a handler aborts when either the client cancels or the
operator calls `stop()`/`reset()`.

`reset()` returns the runtime to its started-but-empty state. It ends the
epoch, clears approvals, idempotency, plans, receipts, routing, and audit,
and reconciles the tool surface. Nothing accumulated before the reset
survives it. `stop()` is narrower and clears only approvals and the tool
surface.

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
approving, and the three levels are ordered by how much that approval is
worth.

`derived` is not selectable. `CapabilitySpec` is a union of
`DirectCapabilitySpec` and `StagedCapabilitySpec`; only the staged variant
reaches the label, and it forbids `execute`, `previewChanges`, and
`approvalEvidence`, so the stronger claim cannot be paired with an unrelated
preview callback. `defineCapability` also refuses the string from a
JavaScript caller that supplies it without a `stage` handler.

`diff` requires `previewChanges` and is an author's enumeration, which can
drift from what `execute` does. A capability with no enumerable change set
must opt in to `summary` by hand. `defineCapability` throws when a
consequential capability declares neither, so a missing preview can never
quietly degrade into an empty diff, which is the failure the contract
exists to prevent.

The chosen mode rides on the `APPROVAL_REQUIRED` payload as
`approvalEvidence`, so a caller can tell whether "approved" meant a human
read a diff the handler produced, a diff the author wrote, or a sentence.

### The human approves the operation, not a description of it

An author-written preview is a second description of an operation, and two
descriptions drift. If they drift, the human consented to something that did
not happen the way it was described, which is the failure this runtime exists
to prevent.

So a capability that writes does not describe its change. It declares `stage`
instead of `execute`, runs on a fork of application state, and the diff is
read off that fork:

```text
agent calls refund_shipping
  → the capability stages on a fork; live state is untouched
  → diff(fork) → will_change on APPROVAL_REQUIRED, ghosted in the UI
  → human approves → the runtime commits that same fork
```

The runtime owns the proposal from the moment it is created until it is
committed or discarded, and disposes it on rejection, denial, unavailability,
reset, stop, a failed commit, and a successful one. It is keyed by the
pending action's id, or by a plan id and operation index, never by business
input, so two approvals never share or overwrite an artifact. A staged
capability has no runnable handler, so an approval whose artifact is gone
fails closed with `STAGED_PROPOSAL_MISSING` rather than running the write
outside what was reviewed.

`approvalEvidence: "derived"` is not selectable, and neither is the proposal.
A capability names an operation the adapter owns and supplies no code at all,
so it can neither describe its own change nor reach live state outside the
fork (this example is `packages/webmcp/examples/staged-capability.ts`, which
`pnpm typecheck` compiles):

```ts
const refundShipping = defineCapability({
  name: "refund_shipping",
  description: "Refund the shipping fee for an order.",
  risk: "CONSEQUENTIAL",
  // No execute, no previewChanges, no approvalEvidence, no code at all. The
  // capability names an operation the adapter owns and the runtime hands it
  // the validated input.
  staging: { operation: "refund_shipping" },
});

const runtime = createAgentDeskRuntime({
  capabilities: [refundShipping],
  // Bound once. The adapter owns the operations, the diff, and the commit,
  // so a capability can neither describe its own change nor reach live state
  // outside the fork this opens.
  staging: meridianStaging,
});
```

The adapter is bound once at `createAgentDeskRuntime` and supplies
`operations`, `scope`, `fork`, `diff`, `commit`, and `release`. Starting with
a staged capability whose operation the adapter does not own is refused, as is
starting with no adapter bound at all.

A commit that throws is not treated as a clean failure. The exception proves
the adapter did not return, not that nothing landed, so every path reports it
the same way: an approval resolves `INDETERMINATE`, a plan resolves
`INDETERMINATE` and stops rather than writing on top of an unknown result, and
a direct write returns `EXECUTION_INDETERMINATE` naming the record and saying
not to retry. The same call is then refused until a human reconciles it, so a
caller cannot apply the change twice by asking twice.

The staged diff is cloned and frozen before anything is dispatched, so
evidence that could not be recorded is refused while refusing is still free.
`listUnreconciled` holds the record until `reconcile` hands the artifact back
to the adapter, and only a resolution the record can accept, and only the
adapter's successful return, settles it. Reset does not clear these records. An adapter that knows nothing was dispatched
says so with `StagedCommitRefused`, which is an ordinary refusal. A `release`
that throws is an attempted cleanup rather than a completed one, so it is
recorded and the artifact stays listed.

The application that composes the runtime still supplies the adapter, so that
is one audited integration point rather than per-operation code. An adapter
whose `diff` disagrees with its `commit`, or whose operation writes outside
its own fork, can still lie. Nothing below the application's data layer can
prevent that.

Staging is synchronous by contract. A handler that suspends resumes after its
fork closed, so `defineCapability` refuses an async handler, `runStage`
refuses a returned promise, and the demo store refuses every later write once
a staged handler has suspended.

Forking is the application's job, since only it knows its data layer. The SDK
owns the artifact's identity and lifecycle and stays out of the store.
Meridian Ops forks in `apps/demo/src/data/store.ts`, derives and merges in
`apps/demo/src/data/branch.ts`, and stages in
`apps/demo/src/capabilities/staged.ts`.

### The human keeps working while an approval is pending

Because the agent writes to a fork, nothing is locked. The human can edit the
same order the agent is proposing against, and on approval a three-way merge
lands both.

Row presence is decided explicitly, so a row the agent deleted is deleted and
a cleared array stays cleared. A field they both wrote is a real conflict, and
the runtime refuses it rather than resolving it. The card warns as soon as the
document moves, and approving anyway fails closed with `APPROVAL_STALE`
instead of applying part of a reviewed change. A capability whose output
depends on state the human might move declares `commitMode: "rederive"`,
which re-runs the handler at approval and refuses if the result no longer
matches what was approved.

A plan stages every operation inside one scope, so the second operation
derives against what the first one staged rather than against state the first
is about to change. Commit consumes those same artifacts in order, and a plan
that has lost one fails whole rather than landing part of itself.

### Staged proposals

A staged capability declares `staging: { operation }`, a name and nothing
else. The adapter is bound once at `createAgentDeskRuntime` and owns the
operations as well as the artifact, so a capability supplies no executable
code and cannot reach live state outside the fork. `start` refuses a
capability naming an operation the adapter does not own. The runtime calls
`adapter.fork`, then derives the proposal from the single opaque
artifact it returns: `changes` from `adapter.diff`, `commit` from `adapter.commit` over
the same artifact. The author supplies neither, so a capability cannot show
one diff and perform a different write, and supplying a `stage` handler
directly is refused, as is a capability that supplies its own adapter. The
runtime owns the resulting proposal, keyed by the pending action's id or by a
plan id and operation index. Once `fork` has produced an artifact, every path
that does not reach a successful commit releases it exactly once, including a
throwing `diff`, a malformed diff, a suspended write, and a throwing
`commit`; a failing `release` never replaces the error that caused it, and is
recorded as a cleanup failure that keeps the artifact listed for a human,
because invoking a hook that throws disposes nothing.

A commit that throws is indeterminate rather than failed. The exception says
the adapter did not return, not that nothing was written, so the approval
resolves `INDETERMINATE`, the artifact is retained rather than released, and
the approved diff stays available through `listUnreconciled` until a human
records what happened with `reconcile`. A plan reports the same fact the same
way: the operation and the plan both resolve `INDETERMINATE`, the record
carries the plan id and the operation index, and later operations are skipped
rather than written on top of a change nobody can confirm.

All three entry points report an unknown commit the same way. A direct
execution returns `EXECUTION_INDETERMINATE` with the record id and the
approved changes, and a later invocation of the same capability and input is
refused while that record is open, because a repeat could apply a change that
already landed. An indeterminate plan emits `plan_indeterminate` rather than
`plan_failed`, so a consumer reading the discriminant is not told the opposite
of the plan's terminal state.

Derived evidence is cloned and frozen at the staging boundary, before any
commit runs, so a diff that cannot become durable evidence is refused rather
than discovered after a write may have landed. Recording an unknown outcome
cannot itself throw.

`reconcile` is an adapter boundary, not a bookkeeping call. It hands the
retained artifact back with a `StagedResolution` of `commit_applied`,
`commit_not_applied`, or `cleanup_disposed`, parsed and checked against the
record's own kind first, so a cleanup resolution cannot settle an unknown
commit. Only the adapter's successful return settles the record. A throwing recovery leaves the record and its evidence in
place. Reset does not clear these records, because a reset cannot close an
artifact still open in the application and deleting the record would lose the
only thing that could find it. The evidence itself is cloned and deep-frozen
at the store boundary, so a caller cannot rewrite what the runtime says
happened. `StagedCommitRefused` and
`CapabilityUnavailableError` are the two ways an adapter states that nothing
was dispatched, and both stay ordinary refusals. Nothing is keyed by business input, so two approvals of the
same capability and input hold two artifacts and neither can consume the
other. A repeated identical request keeps the artifact behind the preview
already shown.

Disposal covers rejection, policy denial, unavailability, an unknown
capability, a throw during the approval checks, a failed execution, an
expired session, `stop`, `reset`, plan rejection, plan drift, plan
interruption, and a successful commit. A refused plan rejection disposes
nothing, because the transition is claimed before the disposal rather than
after.

Idempotency is claimed before staging, not inside the execution. A replay or
a refusal that staged first would build a proposal no path commits or
discards, since only the winning execution reaches disposal. `defineCapability` gives a staged capability a handler
that throws, so a lost artifact produces `STAGED_PROPOSAL_MISSING` rather
than a write outside what the human reviewed.

Staging is synchronous by contract, because a handler that suspends resumes
after its fork has closed. `defineCapability` refuses an `AsyncFunction`,
`runStage` refuses a returned thenable, and a host store can refuse later
writes once a staged handler has escaped.

Plan preparation runs every staging inside one `adapter.scope`, so each
operation derives against its predecessor's staged head. Commit consumes the
same artifacts by index and refuses the whole plan if any is missing, rather
than landing an earlier operation and failing a later one.

A capability that declares `previewChanges` and throws is refused with
`PREVIEW_UNAVAILABLE` instead of being queued, because approving blind is
worse than failing. A WRITE with a broken preview still executes.

## Previews and receipts

Two distinct artifacts, deliberately not merged:

- **Preview** (`previewChanges`, or the changes on a staged proposal) is
  evaluated before execution and answers "what would this do". It rides on
  `APPROVAL_REQUIRED` as `will_change` and renders as a diff on the approval
  card. At `diff` level it is advisory, and a throwing preview is logged
  while the approval proceeds without one. At `derived` level it is evidence,
  because the run that produced it is the run that will land.
- **Receipt** (the `receipt()` result helper) is produced by the handler
  and answers "what did this actually do". It is attached to the tool
  result, the `execution_completed` audit event, and the resolved approval
  record, so `get_action_status` can serve it later.

The receipt is authoritative because only the handler observed both states.
An author-written preview can also be wrong about its own operation, which is
what `derived` removes. Either way a preview can go stale if state changes
between rendering and approval, which is why approval re-checks availability
and input before executing, and why a staged commit refuses when the document
moved under a reviewed change.

## Plans, verification, and provenance

A single approval authorizes one call. Real work is often several calls
that only make sense together, and a human should read them as one unit.
That unit is a *plan*. A plan is versioned, so the authorization stays tied
to the state the human actually reviewed.

Three artifacts sit behind this section. The plan says what will happen and
who asked for it. The verification says whether it did happen. The receipt
history says who made it happen and lets it be undone.

### Plans, verification, and rollback in brief

Some work is several actions that a human should review as one unit.
`prepare()` builds a versioned plan with a preview per operation and
executes nothing.
The plan pins the application revision it was reviewed against, so if the
application moves before commit, the commit is refused and the plan is
marked `DRIFTED` rather than running against state nobody approved. Commit
is an atomic claim, so a double commit executes once.

```ts
const plan = await runtime.prepare({
  operations: [
    { capability: "refund_shipping", input: { order_id: "10428" } },
    { capability: "add_order_note", input: { order_id: "10428", note: "Refunded." } },
  ],
});
// The approver is named explicitly and must be human; the agent that asked
// for the plan cannot authorize it.
runtime.approvePlan(plan.id, { id: "operator-1", name: "Amein", kind: "human" });
await runtime.commitPlan(plan.id);

// Who did what, and whether reading state back confirmed it.
const [entry] = runtime.queryReceipts({ planId: plan.id });
if (entry) {
  await runtime.rollback(entry.id); // refused if the capability cannot undo
}
```

A capability can also declare `verify`, which reads state back after the
write, so a handler that reports a change it did not make is recorded as a
`MISMATCH`. A capability with no verifier reports `UNSUPPORTED` instead of
implying it was checked. Rollback is optional in the same way and says so
plainly rather than inventing a compensating action. Detail in the
subsections that follow.

### Versioned operation plans

`prepare()` builds a plan and executes nothing. Each requested operation is
routed by name, its input is deep-cloned, and `previewChanges` runs to
produce a per-operation preview. A CONSEQUENTIAL capability whose preview
throws makes `prepare()` throw, for the same reason a single consequential
call is refused with `PREVIEW_UNAVAILABLE`. Approving blind is worse than
failing.

The returned `OperationPlan` carries the operations with their previews,
the highest risk across them (`highestRisk`), the `requestedBy` actor, the
`expectedRevision` the plan was built against, and a `status`.
`approvePlan` adds `approvedBy`.

`approvePlan(planId, by?)` resolves its approver as `by ?? actor` and
refuses when that resolves to nothing or to an actor whose `kind` is not
`"human"`, the same contract `markReviewed(receiptId, by?)` uses. In the
normal configuration the ambient actor is the agent, so an approval that
did not name a human would record the requester as its own authorizer. The
check runs before the DRAFT to APPROVED transition is claimed, so a refused
approval leaves the plan in DRAFT and callers never mutate ambient actor
state around an approval click.

**A caller-supplied identity is parsed at the boundary, not merely
narrowed.** `parseActor(value: unknown)` is the only way a value from
outside the runtime becomes an `Actor`. It requires a non-null object, a
string `id` that is neither empty nor only whitespace, a `kind` that is
exactly `"agent"`, `"human"`, or `"system"`, and a `name` that is a string
when present. It returns `{ ok: false, reason }` naming what was wrong, and
on success it rebuilds the actor from the fields it checked, so no extra
property rides along into a plan, a receipt, or the audit stream. The
published SDK is callable from JavaScript, where an `Actor` annotation on a
parameter proves nothing about what arrives, and `{ kind: "human" }` with no
`id` used to approve a plan on behalf of nobody. A malformed identity
refuses with a reason that says the identity was malformed, so a caller can
tell a broken approver from a missing one.

Every identity goes through it, including the ambient one. `adoptActor`
parses what `createAgentDeskRuntime` is configured with and what `setActor`
is handed, and throws `TypeError` on a malformed shape rather than returning
a reason. That asymmetry is deliberate. An approver arrives from a caller
who can be told why it was refused, while an ambient actor is application
configuration with no caller to answer, and a runtime that kept going would
attribute every later write to an identity nobody can resolve. Throwing is
also what `adoptActor` already did for an identity that could not be cloned,
so parsing added no new failure mode.

`isHumanActor` runs on the parsed value. A `kind` check against an object
whose shape nothing established is a narrowing, not a guarantee.

**A caller-supplied identity is normalized once, before it is validated and
before any state changes.** Both paths go through one `resolveHumanActor`
helper. It takes a single frozen snapshot of the caller's object, parses
that snapshot, checks `kind` on the parsed result, and hands that one value
to the plan record and to the audit event. The caller's object is never read
again.

The ordering carries two guarantees that a later snapshot would not. A
getter-backed actor that answers `"human"` to the check and `"agent"`
afterwards cannot be approved as one and recorded as the other, because
there is only one read. And an actor carrying a function, which
`structuredClone` refuses, is turned into `{ ok: false, reason }` before the
transition is claimed rather than a `DataCloneError` thrown out of a plan
already sitting in APPROVED with no approver on it. `ownActor` returns that
discriminated result rather than throwing, so the approval and review paths
cannot drift apart on how they handle it.

```ts
import { createAgentDeskRuntime } from "@agentdesk/webmcp";

const runtime = createAgentDeskRuntime({
  capabilities,
  revision: () => storeRevision(),
  actor: { id: "agent-1", name: "Ops Agent", kind: "agent" },
});
await runtime.start();

const plan = await runtime.prepare({
  operations: [
    { capability: "refund_shipping", input: { order_id: "10428" } },
    {
      capability: "add_order_note",
      input: { order_id: "10428", note: "Shipping refunded per policy." },
    },
  ],
});
// plan.status === "DRAFT", plan.risk === "CONSEQUENTIAL"

runtime.approvePlan(plan.id, { id: "operator-1", name: "Amein", kind: "human" });
const committed = await runtime.commitPlan(plan.id);
if (!committed.ok) {
  console.warn(committed.reason);
}
```

Eight statuses, moved only by the runtime:

```text
DRAFT ──approvePlan──▶ APPROVED ──commitPlan──▶ COMMITTING ──▶ COMMITTED
  │                        │                         ├─▶ PARTIAL
  │                        │                         └─▶ FAILED
  │                        └─ revision moved ──────────▶ DRIFTED
  └──rejectPlan──▶ REJECTED (zero side effects)
```

`approvePlan` and `rejectPlan` act only on a DRAFT and return
`{ ok: false, reason }` otherwise, so an unapproved or rejected plan cannot
be committed. `getPlan` and `listPlans` return detached copies, so a UI
cannot edit a plan a human already reviewed.

`commitPlan` runs the operations in order. Each one goes through the same
gates a single approval uses, minus the approval itself, which the plan
already carries: policy, context availability, `checkInput`, schema
validation, then the same `executeNow` that `approve()` calls. An operation
blocked by one of those gates is recorded as `SKIPPED` with the reason and
does not stop the rest. Outcomes land on `plan.outcomes`, each carrying the
`executionId` of the execution it ran.

**One commit has one executor.** `commitPlan` resolves the acting identity
the moment the plan wins the APPROVED to COMMITTING transition, and hands
that one value to every operation. Resolving it per operation would let a
`setActor` during a suspended earlier operation give a single COMMITTED
plan receipts naming different executors, which contradicts the thing a
plan is for. The human approved one unit of work, so who performed it is
one answer.

The terminal status is resolved from those outcomes in one pass.

- Any `FAILED` outcome makes the plan `FAILED`, and `commitPlan` returns
  `{ ok: false }`.
- Otherwise, every outcome `COMPLETED` with no `MISMATCH` verification
  makes the plan `COMMITTED`, and `commitPlan` returns `{ ok: true }`.
- Otherwise the plan is `PARTIAL`, and `commitPlan` returns
  `{ ok: false }`.

`COMMITTED` is a claim that the work happened, so a plan only earns it by
running everything and having nothing disproved. `PARTIAL` covers an
all-skipped plan, a partly-skipped plan, and a plan carrying a `MISMATCH`.
The refusal reason names the skipped capabilities and the mismatched ones
separately, so a caller can tell "nothing ran" from "it ran and
verification disproved it". `UNSUPPORTED` verification does not block
success, since most capabilities declare no verifier and that is normal.

Reusing the single-approval execute path is the point, not a convenience.
A second execution mechanism would be a second place for the gates to sit,
and gates that exist twice drift apart. The availability re-check, the
epoch guard, the audit events, and the receipt recording all come from the
one implementation, so a fix to any of them applies to plans without anyone
remembering to apply it.

### Drift detection

The runtime takes an optional `revision(ctx)` provider. It is called when
a plan is prepared, stored as `expectedRevision`, and called again at
commit. If the two differ, nothing executes, the plan becomes `DRIFTED`,
the observed value is recorded on it, and a `plan_drifted` audit event is
appended.

This is what makes the approval mean something. A human approves a set of
previews describing a specific application state. If someone else refunded
the same order in between, that approval no longer describes what would
happen, and running it anyway would be a change nobody authorized. The
demo test for this covers exactly that sequence.

A revision is whatever the application says it is. The demo derives one
from order status, refund flags, credit count, and invoice status. Without
a `revision` provider there is no `expectedRevision` and no drift check, so
an application that wants this guarantee has to supply one.

### Committing exactly once

`PlanStore.transition(id, from, to)` is an atomic claim. It returns the
plan only to the caller that found it in the `from` status, and every other
caller gets `undefined`. `commitPlan` claims `APPROVED → COMMITTING` before
doing anything else, so two concurrent commits of the same plan execute the
operations once and the loser gets a structured refusal naming the current
status. This mirrors the `PENDING → EXECUTING` claim in `ApprovalManager`.

### Verification

A handler reporting success is not evidence that the application is in the
promised state. A capability can declare a verifier that reads state back
after the write:

```ts
defineCapability({
  name: "refund_shipping",
  description: "Refund the shipping fee for an order.",
  risk: "CONSEQUENTIAL",
  previewChanges: (input) => [
    { field: "shipping_refunded", before: false, after: true },
  ],
  verify: (input) =>
    findOrder(String(input.order_id)).shippingRefunded
      ? { status: "VERIFIED" }
      : {
          status: "MISMATCH",
          field: "shipping_refunded",
          expected: true,
          observed: false,
        },
  execute: (input) => {
    applyRefund(String(input.order_id));
    return receipt({
      entity: `Order #${String(input.order_id)}`,
      changes: [{ field: "shipping_refunded", before: false, after: true }],
      result: { refunded: true },
    });
  },
});
```

The verifier receives the input, the app context, and the receipt's
recorded changes. It returns one of four results:

- `VERIFIED`. State matches what the change claimed.
- `PARTIAL`, with the fields it could not confirm and an optional note.
- `MISMATCH`, with the field, the expected value, and the observed one.
  This is the case that catches a handler lying about what it did.
- `UNSUPPORTED`. Reported for every capability with no verifier, rather
  than implying an unverified write was checked.

Two rules keep verification from becoming a new failure mode. A verifier
that throws yields `PARTIAL` with a `verifier failed` note, never an error,
because a broken verifier must not turn a completed write into a reported
failure (`runVerification` in `runtime.ts`). And verification runs only
when the handler returned a `receipt()` envelope, since the receipt's
change list is what a verifier checks against. A handler that returns a
plain value is recorded as `UNSUPPORTED` even if the capability declares
`verify`.

The result rides on the stored receipt and, for planned work, on the
operation outcome and the `plan_committed`, `plan_partial`, or
`plan_failed` audit event. Verification is also what a rollback re-runs
before it undoes anything.

### Receipt history

The audit log records that things happened. The receipt store records what
they did, with the evidence attached, so "show me every refund this agent
made" is one call rather than a scan.

```ts
runtime.queryReceipts({
  capability: "refund_shipping",
  actorId: "agent-1",
  planId: plan.id,
  since: Date.now() - 3_600_000,
  limit: 20,
});
```

Every filter is optional and they combine as an AND. `actorId` matches
`executedBy.id`. Results come back newest first, and `limit` applies after
ordering. Each `StoredReceipt` carries `executedBy` when an actor was set,
the originating `planId` when the write came from a committed plan, the
exact input the capability ran with, the handler's receipt, the
verification result, a `rollbackState`, and a timestamp. Stored entries
are frozen.

Provenance is split three ways, because one blended actor hides the thing
an auditor most needs to see. `plan.requestedBy` is who asked, captured at
`prepare`. `plan.approvedBy` is who authorized, named explicitly at
`approvePlan` and required to be human. `receipt.executedBy` is who acted,
captured once when the execution starts. `receipt.reviewedBy` is who looked
afterwards, named explicitly at `markReviewed` and also required to be
human. The two human-only fields say so in their types: `plan.approvedBy`
and `receipt.reviewedBy` are `HumanActor`, not `Actor`, as is the `by`
parameter of `ReceiptStore.markReviewed`. `PlanStore.resolve` takes
`Partial<OperationPlan>`, so the guarantee binds every internal caller
rather than only the runtime entry point. `requestedBy` and `executedBy`
stay `Actor`, because an agent legitimately asks and legitimately acts. No
`as HumanActor` assertion exists in the package; the type is earned by
`parseActor` and the `isHumanActor` predicate. The three actor-mutating paths stay independent: approving and
reviewing take their identity as an argument and never touch the ambient
actor. `setActor` clones and deep-freezes what it stores, so a caller
mutating its own object afterwards cannot rewrite history already recorded.

Each of the four is pinned at the boundary that creates it. `requestedBy` is
resolved before `prepare` calls any `previewChanges`. `executedBy` comes
from the invocation boundary, so neither a synchronous presentation listener
nor a suspended handler can re-attribute work in flight, and a plan commit
pins one executor for all of its operations. `approvedBy` and `reviewedBy`
are snapshotted from the caller's argument, parsed, and checked for `kind`,
all before anything is written.

The input is kept for a specific reason. A rollback has to address the same
entity the original call addressed, and reconstructing that from a change
list would be guesswork.

The store is in-memory and bounded to 500 entries, evicted oldest-first,
like the rest of the runtime's state. Durable storage is an application
concern. Use `subscribeAudit` or export these entries to persist them.

### Rollback

`rollback(receiptId)` calls the capability's optional
`rollback(input, ctx, changes)` with the original input and the changes the
receipt recorded, marks the receipt as rolled back, and appends a
`rollback_performed` event naming the actor that won the claim. That actor
is captured at the claim, before the first `await`, for the same reason an
execution captures its own.

Every receipt carries a `rollbackState` of READY, ROLLING_BACK,
ROLLED_BACK, or INDETERMINATE. `ReceiptStore.claimRollback` moves READY to
ROLLING_BACK and returns false otherwise. It is the receipt-side twin of
`PlanStore.transition`, and the runtime wins it synchronously before its
first `await`. That is what makes it atomic on a single-threaded event
loop. Two concurrent undos of one receipt therefore reach the compensating
action once, and the loser is told the rollback is already in flight.

Only a refusal that happens before the handler is dispatched releases the
claim back to READY, because only then can nothing have run. A dispatched
compensating action that throws goes to INDETERMINATE instead, carrying
`rollbackAttemptedAt` and `rollbackFailure`, and appends a
`rollback_indeterminate` event.

An exception proves the handler did not return. It never proves the handler
did not write, and nothing the runtime can observe closes that gap. An
execution verifier answers whether the original write is still visible,
which is a different question from whether the compensation ran; the two
coincide only when the compensation is the exact inverse of the write. A
compensation that is itself a forward transaction leaves the original state
visible, so inferring "safe to retry" from a verifier is how a second
refund happens.

`reconcileRollback(receiptId, outcome, by?)` is the only exit. A caller who
read the application says `compensated`, which spends the receipt, or
`untouched`, which makes undo available again. It records `reconciledAt`,
`reconciledBy`, and a `rollback_reconciled` event. The runtime never
reconciles on its own.

Success is not the handler's to declare either, and `verify` cannot settle
it. `verify` asks whether the original change is still visible, so it
detects an undo that did nothing and stops there. Its MISMATCH says state
moved without saying where to, and an undo that lands on a third value is
not a rollback.

`verifyRollback(input, ctx, changes)` asks the question that matters after
an undo, whether the receipt's recorded `before` values are back. A
capability declares it, or declares `rollbackEvidence: "handler"` to accept
the handler's word deliberately, exactly as `approvalEvidence: "summary"`
works for approvals. Declaring neither leaves the receipt INDETERMINATE, no
`rollback_performed` is written, and a human reconciles it. The outcome is
stored as `rollbackVerification`, so a reader can tell a proven undo from an
accepted one.

One disproof outranks the opt-out. If `verify` reports the original change
still in place, the undo demonstrably did nothing, and the receipt is
unreconciled whatever `rollbackEvidence` says.

The decision is a `RollbackProof` of `proven`, `accepted`, or
`unreconciled`, not a verification status. Those are different facts, and
collapsing them was a real defect: `UNSUPPORTED` meant both "a declared
verifier could not check" and "the capability accepts the handler's word",
so a verifier answering `UNSUPPORTED` recorded a rollback nobody had
proven. Only `accepted` comes from the opt-out. Declaring `verifyRollback`
alongside `rollbackEvidence: "handler"` is a contradiction and
`defineCapability` rejects it.

Before calling the handler, the runtime re-runs the capability's `verify`
against the receipt's stored input and changes. Anything other than
`VERIFIED` releases the claim and refuses with a conflict, because the
application state no longer matches what the receipt described and undoing
it would overwrite a later change. A verifier that throws counts as a
conflict too. Undo is destructive, and unknown state is not safe to
overwrite.

**A capability with no verifier gets none of that protection.** The runtime
cannot detect drift it has no way to read, so the rollback proceeds. Any
capability that wants a safe undo has to declare `verify`.

It refuses in five cases, each with a reason string rather than a silent
no-op. An unknown receipt id. A capability that declares no `rollback`. A
receipt already rolled back. A receipt whose rollback is already in
flight. And a verification conflict.

Handing the recorded `changes` to the rollback is what makes it more than a
guess. The demo's `refund_shipping` restores the invoice status from the
`before` value in the receipt and deletes the specific credit id the
receipt named, rather than assuming what the prior state must have been. It
also carries its own guard for the state the SDK verifier does not cover.
Inside one `mutate`, it confirms the invoice status still equals the
receipt's `after` value and the named credit still exists, then writes.
A conflict throws and names what moved.

Rollback is a capability-authored compensating action, not a transaction.
It runs through the capability, not around it, and it can fail. A throwing
rollback returns `{ ok: false, reason }` and the receipt becomes
INDETERMINATE until someone reconciles it.

### Audit events

Eleven event kinds are added to the `AuditEvent` union, all carrying `at`:

| Kind | Payload beyond `planId` |
| --- | --- |
| `plan_prepared` | `operations`, `risk` |
| `plan_approved` | `actor`, the human approver, required and typed `HumanActor` |
| `plan_rejected` | none |
| `plan_drifted` | `expectedRevision`, `observedRevision` |
| `plan_committed` | `outcomes` (capability, status, verification) |
| `plan_partial` | `outcomes` (capability, status, verification) |
| `plan_failed` | `outcomes` (capability, status, verification) |
| `rollback_performed` | `capability`, `receiptId`, `actor` (no `planId`) |
| `rollback_indeterminate` | `capability`, `receiptId` (no `planId`) |
| `rollback_reconciled` | `capability`, `receiptId`, `outcome`, `actor` typed `HumanActor` (no `planId`) |
| `receipt_reviewed` | `capability`, `receiptId`, `actor` typed `HumanActor` (no `planId`) |

Six kinds carry an acting identity, and every one of them uses the same
`actor` field so the stream stays queryable on one key.
`execution_started`, `execution_completed`, and `execution_failed` name who
ran the capability, resolved once at the invocation boundary.
`plan_approved` names the human who authorized the plan. `receipt_reviewed`
names the human who reviewed the receipt. `rollback_performed` names who
claimed the undo.

The two human-only events say so in their types. `plan_approved` and
`receipt_reviewed` declare `actor` as required and typed `HumanActor`, which
is `Actor & { kind: "human" }`, exported from the package alongside `Actor`.
Both are only ever emitted with an identity the runtime has already
validated, and the runtime narrows to that type through the `isHumanActor`
predicate rather than asserting, so the compiler carries the guarantee
instead of the reader. A consumer reads `event.actor.kind` after narrowing
on `event.kind` with no cast and no check for a case that cannot occur. The
other four keep `actor` optional and typed `Actor`, because an execution or
a rollback legitimately names an agent, and because no actor is a valid
state for a runtime nobody configured one on.

The role-specific names live on the plan and the receipt (`requestedBy` and
`executedBy` typed `Actor`, `approvedBy` and `reviewedBy` typed
`HumanActor`); the audit stream deliberately
does not mirror them, because an auditor asking "what did this person do"
should not have to union four differently named fields. The remaining kinds
record what the runtime did rather than who asked for it.

They flow through the same `AuditBus` as everything else, so
`subscribeAudit` delivers them and `getSnapshot().audit` includes them with
no special handling. The demo's `ActivityPanel` renders every kind. Its
`switch` ends in a `never`-typed default, so a new kind fails to compile
until it gets a case rather than vanishing from the panel.

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

### Guided execution

The agent calls tools; it does not click through the UI. But a human
watching a screen should still see what the agent is acting on. AgentDesk
separates execution from presentation:

```text
agent intent → WebMCP capability executes → presentation events
            → UI navigates, reveals the affected value, narrates
```

A capability declares presentation hints alongside its schema:

```ts
defineCapability({
  name: "get_order_shipping",
  presentation: {
    route: (input) => `/orders/${input.order_id}`,
    reveal: "shipping-summary",
    message: (input) => `Checking whether shipping was paid on order #${input.order_id}`,
  },
  // ...
});
```

The runtime resolves those to plain data and emits them on a separate
stream (`runtime.subscribePresentation`); navigating, scrolling, and
highlighting stay the UI's job. The WebMCP result is authoritative whether
or not anyone subscribes, and a throwing presentation listener cannot
affect execution. Toggle **Presence: guided / fast** in the header; `fast`
executes identically with no UI movement.

There is deliberately no simulated cursor. Every motion in guided mode
reflects state the agent actually touched, rather than pantomiming an
input device it never used.

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

<!-- code-anchors
packages/webmcp/src/receipts.ts RollbackState ReconciliationOutcome reconcile markIndeterminate rollbackVerification rollbackAttemptedAt rollbackFailure
packages/webmcp/src/capability.ts verifyRollback rollbackEvidence Unavailability repair
packages/webmcp/src/runtime.ts reconcileRollback markRolledBack proveRollback ownActor routable visibleRepair situationFor partition desiredNative
packages/webmcp/src/audit.ts rollback_indeterminate rollback_reconciled rollback_performed grant_issued grant_revoked grant_applied grant_not_applied
packages/webmcp/src/protocol.ts Repair Evidence Situation Refusal Settled ResultProtocol RefusalStatus
packages/webmcp/src/results.ts completed capabilityUnavailable approvalRequired executionIndeterminate
packages/webmcp/src/grants.ts Grant LiveGrant GrantRequest ScopeRule ConsideredGrant GrantOutcome GrantStore parseScope parseGrantRequest matchesScope consult spend revoke liveCapabilities
packages/webmcp/src/runtime.ts adoptHumanActor authorizing considered queueApproval revokeGrant listGrants getGrant currentDigest hasPreviewSource
packages/webmcp/src/staging.ts stateDigest
packages/webmcp/src/results.ts approvalStale viewUnavailable EvidenceLink AuthoredEvidenceLink evidence source
packages/webmcp/src/runtime.ts deriveEvidence linksThroughView settledReceipt
packages/webmcp/src/protocol.ts link
packages/webmcp/src/capability.ts AgentView agentView
packages/webmcp/src/runtime.ts throughView changesThroughView hiddenStrings withhold crossing agentText viewFailed runInvocation approveInner
packages/webmcp/src/approval.ts stateVersion
packages/webmcp/src/plan.ts stateVersion
packages/webmcp/src/receipts.ts grantId
-->
