# P1: A rollback that commits and throws can run twice

Status: OPEN

Reviewed commit: `812e5b9`

## Finding

When a rollback handler throws, `rollback()` unconditionally moves the receipt from `ROLLING_BACK` back to `READY`. A thrown error does not prove that the compensating write did not commit. Retrying the receipt can therefore run the compensation twice.

This repeats the same failure class previously fixed in the WebMCP client. Failure after dispatch cannot be used as evidence that a write is safe to retry.

## Evidence

A deterministic rollback handler increments a commit counter, then throws as if response serialization failed after the application write.

```json
{
  "rollbackCommits": 2,
  "first": {
    "ok": false,
    "reason": "response serialization failed after commit"
  },
  "afterFirst": "READY",
  "second": {
    "ok": false,
    "reason": "response serialization failed after commit"
  },
  "afterSecond": "READY"
}
```

Both calls reached the compensating action. The runtime invited the second call by treating the first exception as proof that no compensation landed.

## Affected code

- `packages/webmcp/src/receipts.ts`, `releaseRollback()`
- `packages/webmcp/src/runtime.ts`, rollback catch path

## Required behavior

- Do not return a thrown rollback to `READY` automatically.
- Represent the outcome as indeterminate until application state is reconciled.
- Require explicit recovery or a capability-authored check that can establish whether the compensation landed.
- Never run the same compensating write again based only on a caught exception.
- Document that abort or failure after rollback dispatch does not imply that nothing changed.

## Regression test

Use a rollback handler that commits one observable side effect and then throws. Call `rollback()` twice. Assert that the handler runs once and the second call is refused as indeterminate rather than retried.

