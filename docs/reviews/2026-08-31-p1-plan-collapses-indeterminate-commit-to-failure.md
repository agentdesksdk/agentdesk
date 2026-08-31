# P1: a plan collapses an indeterminate commit to failure

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `5a6d828`

## Finding

`runExecution` correctly returns an `indeterminate` outcome when a staged
commit may have landed and then throws. `commitOperation` discards that
discriminant and returns the ordinary operation status `FAILED`. The plan then
resolves `FAILED` and emits `plan_failed`.

This was reproduced against the built package with a one-operation plan whose
adapter writes `status = cancelled` and then throws `ack lost`. Live state was
`cancelled` and `listUnreconciled()` contained `UNREC-1`, while the plan and its
only operation both said `FAILED` and `commitPlan` reported "1 of 1 operations
failed". The single-approval path reports the same execution as
`INDETERMINATE`, so the two entry points disagree about the same fact.

Calling this a failure invites the retry that the new indeterminate model was
added to prevent. The unreconciled record also has no `planId`, so a caller
cannot connect it to the failed plan without correlating audit timestamps.

## Required correction

Make indeterminate an explicit `OperationOutcome` and terminal plan state (or
an equally explicit plan-level outcome). Preserve the reconciliation record id
and associate it with the plan and operation. Do not collapse it into
`FAILED`, and specify whether later operations stop or continue once an
earlier result becomes unknown.

## Regression requirement

Commit a staged plan operation that mutates live state and then throws. Assert
that neither the operation nor the plan says `FAILED`, that the record is
linked to the plan operation, and that the result tells the caller not to
retry. Include a second operation to pin the intended continuation rule.

## Resolution

`OperationOutcome.status` gains `INDETERMINATE` and carries the `recordId`;
`PlanStatus` gains `INDETERMINATE` too. `commitOperation` no longer collapses
the discriminant, keeps the artifact instead of discarding it, and attaches
the record to the plan and the operation index. The two entry points now agree
about the same fact.

The continuation rule is stop. Once an operation's result is unknown, every
later operation is marked `SKIPPED` with a detail naming what left the result
unknown, because a later write would be building on a change nobody can
confirm. `commitPlan` returns a reason that names the record and says not to
retry.

Covered by three probes in
`packages/webmcp/tests/staged-reconciliation.test.ts`, including a
two-operation plan pinning the continuation rule.
