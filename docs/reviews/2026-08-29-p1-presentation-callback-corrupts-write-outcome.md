# P1: Presentation callback failure corrupts a completed write outcome

Status: RESOLVED in `2f1f332`

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
