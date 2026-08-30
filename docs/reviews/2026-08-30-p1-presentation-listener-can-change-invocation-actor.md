# P1: A presentation listener can change the invocation actor

Status: RESOLVED on `fix/acting-identity`

Reviewed commit: `2bc6f6a`

Validated: `packages/webmcp/tests/identity-boundaries.test.ts` passed on
`fix/acting-identity`, 6 of 6, alongside the full 339-test suite.
`runCapability` now resolves the acting identity into a local const at its
first statement, before any `present()` call and before the first audit
append, and threads that value through `capability_started`,
`approval_requested`, `executeNow`, and `runExecution`. `runExecution` no
longer reads the mutable binding at all. It takes the actor as a required
`ExecutionOptions` field, so the compiler rejects any entry point that does
not resolve one. The probe that produced the evidence below now reports
`agent-a` on both presentation events, on `execution_started` and
`execution_completed`, and on the receipt's `executedBy`.

## Finding

`2bc6f6a` captured the acting actor inside `runExecution`. That is not the
earliest point of an invocation. `runCapability` emits
`capability_started` from the mutable runtime-level `actor` binding before
`runExecution` runs.

Presentation listeners dispatch synchronously. A listener that reacts to
`capability_started` by calling `setActor` therefore runs to completion
before `runCapability` reaches `executeNow`, and the execution that follows
captures the actor the listener installed. One invocation is split across
two actors, and the split is visible in the presentation stream, the audit
log, and the stored receipt at once.

The same gap exists on the approval path. `approve()` reaches `executeNow`
after re-running policy, availability, and `checkInput`, and captured
nothing of its own before them.

## Evidence

A deterministic probe subscribed a presentation listener that calls
`setActor(agent-b)` on `capability_started`, then invoked a WRITE
capability as `agent-a`.

Observed result:

```json
{
  "presentation": [["capability_started", "agent-a"], ["capability_completed", "agent-b"]],
  "audit": [["execution_started", "agent-b"], ["execution_completed", "agent-b"]],
  "receipt": "agent-b"
}
```

The invocation began as `agent-a` and every record of what it did names
`agent-b`. A read-only observer changed the provenance of a write.

## Affected code

- `packages/webmcp/src/runtime.ts`, `runCapability()`, `present(capability, "capability_started", input, actor)`
- `packages/webmcp/src/runtime.ts`, `runCapability()`, `present(capability, "approval_requested", input, actor)`
- `packages/webmcp/src/runtime.ts`, `runExecution()`, `const actingActor = actor`
- `packages/webmcp/src/runtime.ts`, `approve()`, `executeNow(routed, action.input, { humanInitiated: true })`

## Required behavior

- Resolve the acting identity at the boundary that begins an invocation, before any presentation event and before any audit append.
- Thread that one value through every presentation event, audit event, and receipt belonging to the invocation.
- Let `runExecution` use the actor it is handed rather than reading the mutable binding.
- Apply the same rule at every other entry point that begins an invocation, including `approve()`.
- Make the threading a required argument so a new entry point cannot silently fall back to the ambient read.

## Regression test

Subscribe a presentation listener that calls `setActor(B)` on
`capability_started`. Invoke a WRITE capability as actor A. Assert that both
presentation events, both execution audit events, and the receipt's
`executedBy` all name A.
