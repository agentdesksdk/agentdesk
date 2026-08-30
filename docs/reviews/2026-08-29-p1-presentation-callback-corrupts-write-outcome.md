# P1: Presentation callback failure corrupts a completed write outcome

Status: RESOLVED in `bf079ca`. `f7c6d1f` moved the boundary without closing it; see the correction below.

Reviewed commit: `6a1745e`

Validated: focused regression suite passed on `2f1f332`. Each resolver is now isolated at the presentation boundary. The post-write failure probe keeps the write successful and produces no contradictory `execution_failed` event.

## Finding

`resolvePresentation()` executes application-owned `route`, `message`, and `announce` callbacks inline with capability execution. `runExecution()` records `execution_completed`, then calls `present()` inside the same `try` block. If a presentation callback throws after the handler commits, the runtime records `execution_failed` for the same execution and rejects the invocation even though the write and receipt were already committed.

Presentation is optional choreography. It must not change a capability's execution result.

## Evidence

A deterministic probe used a WRITE capability whose handler increments a counter and whose `announce` callback succeeds before execution but throws after the counter changes.

Observed result:

```json
{
  "commits": 1,
  "first": { "rejected": "post-write formatter exploded" },
  "audit": [
    { "kind": "execution_started", "executionId": "EXE-1" },
    { "kind": "execution_completed", "executionId": "EXE-1" },
    { "kind": "execution_failed", "executionId": "EXE-1" }
  ]
}
```

The same execution is reported as both completed and failed. A caller receives failure after the mutation landed.

An always-throwing presentation callback also escapes `runtime.invoke()` as a raw rejected promise during `capability_started`, instead of producing the runtime's structured tool failure.

## Affected code

- `packages/webmcp/src/presentation.ts`, `resolvePresentation()`
- `packages/webmcp/src/runtime.ts`, `present()` and `runExecution()`

## Required behavior

- Catch errors from every application-owned presentation resolver at the presentation boundary.
- Log or emit a presentation-specific diagnostic without changing the capability result.
- Never append `execution_failed` after `execution_completed` for the same execution.
- Keep successful writes successful when presentation choreography fails.
- Keep `runtime.invoke()` on its structured result contract when presentation setup fails.

## Regression tests

Add tests for both timing points:

1. A presentation callback throws during `capability_started`. The handler does not run and the call returns a structured failure or proceeds without presentation according to the chosen contract.
2. A presentation callback throws during `capability_completed`. The handler runs once, the call remains successful, the receipt remains queryable, and the audit contains no `execution_failed` for that execution.

## What `f7c6d1f` added

`2f1f332` guarded each presentation resolver, which closed the reported
trigger. It left the invariant itself unenforced, so any future throw between
`execution_completed` and the end of `runExecution` reopened the defect. A
probe found one that `2f1f332` did not cover. Invoking with input that
`structuredClone` cannot copy throws inside `receipts.record`, after the
completion event has already landed:

```
expected [ 'EXE-1' ] to deeply equal []
```

`EXE-1` was recorded as both completed and failed. The bookkeeping that
follows the completion event now runs in its own `try`, so a throw there is
logged and cannot reach the catch that appends `execution_failed`.

## Correction: still OPEN

Marking the invariant enforced in `f7c6d1f` was wrong. That commit put the
receipt write and the presentation call inside their own `try`, which stops
those two from contradicting a completed execution. It moved the boundary
rather than closing it, and it introduced a second failure in the process.

- `result: toToolResult(value)` sits in the return statement, outside that
  `try`. A value `JSON.stringify` cannot serialize still appends
  `execution_failed` after `execution_completed`. Probed with a `bigint` in
  the receipt result: one completed event, one failed event, same execution.
- Swallowing the receipt write traded a wrong failure for a silent loss.
  Probed with uncloneable input, the call returns success and
  `queryReceipts()` is empty. In a governance SDK, losing the evidence
  quietly is worse than the contradiction it replaced.

Finalization needs to be one boundary. Normalize the input and the result
before anything is committed, commit the terminal outcome, and only then run
presentation.

## Resolution in `bf079ca`

Finalization is one boundary. The tool result and the receipt entry are both
built before anything is written, so a result that will not serialize and a
receipt the store cannot hold are failures of the execution while the failure
path is still reachable. The audit event and the receipt are then written
together, and presentation runs last, where a throw is logged and cannot
reach the outcome.

Input the receipt store cannot hold is refused before the handler runs. The
previous commit discovered it afterwards and swallowed it, which returned
success with no receipt. Losing the governance evidence quietly is worse than
the contradiction it replaced, and refusing at the boundary means the write
never happens rather than happening unrecorded.

The regression test asserts the general invariant, that no execution id ever
carries two terminal events, rather than the single trigger that was reported.
