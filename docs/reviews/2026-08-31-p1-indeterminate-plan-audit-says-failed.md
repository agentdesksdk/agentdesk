# P1: the audit and UI call an indeterminate plan failed

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `d43ae10`

## Finding

The plan store now correctly resolves `INDETERMINATE`, but the terminal audit
branch maps both `FAILED` and `INDETERMINATE` to `plan_failed`. The demo
consumes that event kind as authoritative and renders "Plan failed".

This was reproduced against the built package: `getPlan(planId).status` was
`INDETERMINATE`, while the audit contained `kind: "plan_failed"` for the same
plan with an `INDETERMINATE` operation. The event payload allows a careful
consumer to rediscover the truth, but its discriminant and shipped UI say the
opposite.

## Required correction

Add a distinct `plan_indeterminate` audit event and presentation treatment, or
otherwise make the event discriminant match the plan's terminal state. Do not
teach every consumer to reinterpret `plan_failed` by inspecting its children.

## Regression requirement

Assert that an indeterminate plan emits no `plan_failed` event and that the
demo activity panel renders an unknown/reconciliation state rather than
"Plan failed".

## Resolution

`plan_indeterminate` is its own audit event, emitted when the plan resolves
`INDETERMINATE`, so a consumer reading the discriminant is not told the
opposite of the plan's terminal state. The demo activity panel renders it as
"Plan outcome unknown" with the operation that may or may not have landed and
an instruction to reconcile before retrying; the panel's exhaustiveness check
would have failed to compile had the case been left out.

Covered by a probe asserting the plan is `INDETERMINATE`, that
`plan_indeterminate` was emitted, and that `plan_failed` was not.
