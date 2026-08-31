# AgentDesk

**A capability-virtualization runtime for WebMCP applications.**

WebMCP gives websites tools. AgentDesk exposes the right tools at the right
time, explains capability state, and keeps consequential actions under human
control.

Built for the OpenAI WebMCP Challenge. TypeScript, no backend, no model API,
static deployment.

## The problem

A real application has dozens or hundreds of operations. Register them all as
WebMCP tools and the agent gets a flat, expensive, ambiguous surface: our
demo catalog alone is 78 capabilities and tens of kilobytes of schema before
the agent has done anything. Big surfaces cost context, invite wrong-tool
calls, and make dangerous actions look exactly like safe ones.

## How it works

```text
large internal capability catalog (78)
  → context-aware deterministic router
  → dynamic native WebMCP registration (≤6 typed tools at a time)
  → availability with structured reasons + suggested alternatives
  → risk policy: READ / WRITE execute, CONSEQUENTIAL needs a human
  → two-phase approval that never blocks a WebMCP call
  → audit timeline of everything
```

The agent always sees four bootstrap tools: `get_context`,
`find_capabilities`, `invoke_capability`, `get_action_status`. Calling
`find_capabilities` with a task routes the catalog, registers the few
relevant capabilities as real typed native tools, retires the rest, and
explains anything relevant-but-unavailable.

## Why WebMCP

This is a WebMCP-native implementation, not an MCP bridge. The runtime
registers typed tools directly on the page's `document.modelContext`, uses
`AbortController` signals for retirement, and treats the browser page as the
single source of capability truth. No local daemon, no gateway, no server.

## Native mode

The unabstracted integration point (`packages/webmcp/src/webmcp-adapter.ts`
and `tool-surface.ts`):

```ts
const controller = new AbortController();
await document.modelContext.registerTool(
  {
    name: "refund_shipping",
    description: "Refund the shipping fee for an order…",
    inputSchema: { type: "object", required: ["order_id"], properties: { … } },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (input) => runCapabilityPipeline(input),
  },
  { signal: controller.signal },
);
// retiring the tool later:
controller.abort();
```

## Compatibility mode

Clients cache tool lists. `invoke_capability` is always registered and
executes any catalog capability by name through the exact same pipeline as
the native tools, so an agent with a stale list is never stranded. Stale
native calls hit a tombstone and get a structured `TOOL_RETIRED` response
telling them to call `find_capabilities` again.

Measured client behavior (Codex in-app browser, 2026-08-28): AgentDesk
dynamically updates the native WebMCP surface, with client rediscovery
occurring when the client refreshes its tool snapshot, typically the next
turn; `invoke_capability` covers clients whose discovery lags behind the
page. Full matrix in [docs/testing.md](docs/testing.md).

## Guided execution

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

## The human approves the operation, not a description of it

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
A capability declares an application adapter and a write; the runtime builds
the artifact and derives both the diff and the commit from it, so an author
has nothing to fabricate:

```ts
defineCapability({
  name: "refund_shipping",
  risk: "CONSEQUENTIAL",
  // No execute, no previewChanges, no approvalEvidence, no proposal. The
  // staged run is the preview, and it is the change.
  staging: { adapter: stagingAdapter, write: refundShipping },
});
```

The adapter is bound once at `createAgentDeskRuntime` and supplies `scope`,
`fork`, `diff`, `commit`, and `release`. A capability declares only its write,
so a capability author cannot influence its own evidence at all. The
application that composes the runtime still supplies the adapter, so that is
one audited integration point rather than per-operation code. Starting with a
staged capability and no bound adapter is refused.

Staging is synchronous by contract. A handler that suspends resumes after its
fork closed, so `defineCapability` refuses an async handler, `runStage`
refuses a returned promise, and the demo store refuses every later write once
a staged handler has suspended.

Forking is the application's job, since only it knows its data layer. The SDK
owns the artifact's identity and lifecycle and stays out of the store.
Meridian Ops forks in `apps/demo/src/data/store.ts`, derives and merges in
`apps/demo/src/data/branch.ts`, and stages in
`apps/demo/src/capabilities/staged.ts`.

## The human keeps working while an approval is pending

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

## Approval is a state machine, not a modal

Every consequential action gets an auditable record with an
execution-time re-check, so approving stale state fails closed instead of
mutating:

```text
PENDING ──approve──▶ re-check availability + input ──▶ APPROVED_EXECUTED (result attached)
   │                          │
   │                          └─ state changed while pending ──▶ FAILED_UNAVAILABLE (reason code)
   └──reject──▶ REJECTED (zero side effects)
```

Agents confirm outcomes later via `get_action_status(approval_id)`.

## Plans, verification, and rollback

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
plainly rather than inventing a compensating action. Detail in
[docs/architecture.md](docs/architecture.md).

## Demo: Meridian Ops

A fictional operations console (customers, orders, inventory, shipping,
billing, support, reports) with a deterministic seeded dataset, running
entirely in the browser.

Hero prompt:

> Find Alice Johnson's unshipped order. If she paid shipping, refund the
> shipping fee. Do not perform the refund without my approval.

Order **#10428** is seeded: processing, not shipped, $18.00 shipping paid,
not refunded. The flow shows routing (78 → ≤6), typed native activation, the
approval card, the audit timeline, and the state change. **Reset Demo**
restores the pristine seed instantly.

## Baseline experiment

The same catalog powers two routes:

- **`/baseline`** — control condition: every applicable capability
  registered as a flat WebMCP surface. A permanent banner marks it.
- **`/agentdesk`** — bootstrap + routed working set.

Same capabilities, same handlers, different exposure. The Benchmark panel
measures catalog size, active tool count, serialized schema bytes (from the
actual registered definitions), invocations, stale calls, and elapsed task
time per run. Token figures are labelled estimates (bytes ÷ 4, same
estimator both modes). See `docs/benchmark.md`.

## Architecture

```text
packages/webmcp     @agentdesk/webmcp — the SDK. No React, no DOM deps
                    beyond document.modelContext behind one adapter.
apps/demo           Meridian Ops (Vite + React 19). React observes only.
apps/p0             Bare HTML/TS browser-compatibility harness (/p0/).
docs/               architecture, runtime notes, benchmark, testing.
```

Invariants (enforced by tests, detailed in `docs/architecture.md`):
only the adapter touches `document.modelContext`; only ToolSurfaceManager
registers tools; native and compatibility calls share one pipeline;
availability is re-checked at execution and approval time; consequential
calls return immediately with an `approval_id`.

## Beyond operations consoles

The same runtime fits any application with a wide capability surface and a
few actions a human should personally authorize: slide editors, design
tools, IDEs, admin platforms. Structured operations beat synthesized input
there for the same reason they do here, and more so, because GUI editing
depends on pixel geometry and continuous pointer state that a
screenshot-action loop cannot observe. AgentDesk is a layer an application
adopts, not a wrapper over someone else's app. See
[docs/future-directions.md](docs/future-directions.md) for the catalog
shape, batched edit sessions, and the integration constraint. None of it is
implemented; Meridian Ops is the proof.

## Running locally

```bash
pnpm install
pnpm dev     # demo app  → http://127.0.0.1:4178
pnpm p0      # P0 harness → http://127.0.0.1:4177/p0/
```

## Testing

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Deployment

Static. `pnpm build` produces `apps/demo/dist` with the P0 harness copied to
`/p0/`. `netlify.toml` and `vercel.json` are included with SPA fallbacks:

```bash
netlify deploy --prod    # or: vercel deploy --prod
```

No environment variables, no secrets, no server.

## License

MIT — see [LICENSE](LICENSE).
