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


## Confirmed on `main`

Still reproduces at `f3a120e`, so the merges of #2 and #5 did not close it.

The blast radius is narrower than "can run twice" suggests, and the boundary
is worth knowing before anyone fixes this. A probe ran the same
commit-then-throw handler twice, once for a capability declaring `verify` and
once without.

| `verify` declared | Compensating action ran | Second call |
| --- | --- | --- |
| no | twice | retried, same error |
| yes | once | refused, `rollback conflict on RCPT-1` |

With a verifier the drift check added in #2 already refuses the retry,
because a compensation that landed leaves state no longer matching the
receipt. Without one there is nothing between the caught exception and a
second compensating write.

That is the same constraint `docs/design/operation-plan.md` records for
generated capabilities. They rarely declare `verify`, so the case with no
protection here is the same case that has no protection there.

## Resolved

Fixed on `cdb2f8b`. `RollbackState` gains `INDETERMINATE`, and a compensating
action that throws after dispatch parks the receipt there instead of
returning it to `READY`.

The premise the old design rested on was written into its own doc comment,
which said a failed compensating action returns to READY "because a rollback
that could not run is a retry, not a dead end". An exception proves the
handler did not return. It never proves the handler did not write.

One path still returns to `READY`, and only on evidence. When the capability
declares `verify`, the runtime runs it after the throw. Finding the original
write still intact is proof the compensation never landed, so the receipt is
genuinely retryable. Anything else, including a verifier that throws or a
capability with no verifier at all, is indeterminate.

A second `rollback()` on an indeterminate receipt is refused by name and
says why, rather than running the compensating write again.

Regression test: `packages/webmcp/tests/rollback-indeterminate.test.ts`,
five cases across commits-or-not and verifier-or-not.
