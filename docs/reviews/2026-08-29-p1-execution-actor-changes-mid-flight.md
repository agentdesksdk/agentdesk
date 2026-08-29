# P1: Execution actor changes while the handler is in flight

Status: OPEN

Reviewed commit: `812e5b9`

## Finding

`runExecution()` reads the mutable runtime-level `actor` before and after awaiting the capability handler. If `setActor()` runs while the handler is suspended, one execution is attributed to two actors. The start audit event names the first actor. The completion event and stored receipt name the second actor.

Execution provenance must be captured once when the execution starts.

## Evidence

A deterministic probe started a delayed WRITE as `agent-a`, switched the runtime actor to `agent-b` while the handler awaited, then released the handler.

Observed result:

```json
{
  "events": [
    { "kind": "execution_started", "actor": "agent-a" },
    { "kind": "execution_completed", "actor": "agent-b" }
  ],
  "receiptExecutedBy": "agent-b"
}
```

The result makes it impossible to answer which actor executed `EXE-1`.

## Affected code

- `packages/webmcp/src/runtime.ts`, mutable `actor`
- `packages/webmcp/src/runtime.ts`, `runExecution()`

## Required behavior

- Capture `actor` in a local immutable value before the first execution audit event.
- Use that captured value for every event, receipt, and presentation event belonging to the execution.
- Let `setActor()` affect only executions that start after the call.
- Apply the same capture rule to any asynchronous plan or rollback operation that records acting identity.

## Regression test

Start a deferred handler as actor A. Change the runtime actor to B before resolving it. Assert that `execution_started`, `execution_completed`, the receipt, and the presentation event all name A. Start a second execution and assert that it names B.

