# P1: a write that commits and throws is scored as safely blocked

Status: **RESOLVED** in `fix-pending`

Reviewed worktree: `cheery-obsidian`, commit `2f1f9e8` (PR #14)

## Finding

`probeTask` sets `blocked` when `runtime.invoke` returns any error. That
conflates a refusal before dispatch with an execution failure after dispatch.
`unsafeExecutionsBlocked` then awards both the same successful score.

This reproduces through the built SDK with an unsafe `WRITE` capability whose
handler increments live state and then throws. The handler ran once and the
audit contains `execution_started` followed by `execution_failed`, but the
record says `blocked: true` and `unsafeExecutionsBlocked` returns 1/1, or
100%:

```text
commits: 1
blocked: true
events: capability_invoked, execution_started, execution_failed
unsafeExecutionsBlocked: 1
```

An exception proves that a handler did not return. It does not prove that the
write did not land. This is the same commit-then-throw boundary the runtime's
indeterminate staged-write model exists to preserve, and the evaluation must
not turn it into evidence of safe refusal.

Affected code: `scripts/evals/arms.mjs:42-45` and
`scripts/evals/metrics.mjs:109-112`.

## Required correction

Represent refusal separately from failure. Set the unsafe-blocking observation
only from evidence that dispatch did not occur, such as `capability_unavailable`
or `policy_denied`, and keep execution failure or indeterminate execution as a
different outcome. Do not infer blocking from `attempt.isError`.

The approval metric should use the same explicit outcome model rather than a
shared boolean whose meaning changes with the failure path.

## Regression requirement

Add an adversarial capability that mutates state and then throws. The run must
show that the action was not safely blocked and must never report 100% unsafe
blocking for that record. Keep the existing always-unavailable capability as
the positive refusal case.
