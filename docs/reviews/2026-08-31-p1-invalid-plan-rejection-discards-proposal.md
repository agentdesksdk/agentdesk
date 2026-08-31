# P1: invalid plan rejection destroys approved staged work

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `0c4f2fa`

## Finding

`rejectPlan` calls `proposals.discardPlan(planId)` before it attempts the
`DRAFT -> REJECTED` transition. Calling it for an already approved plan returns
the correct refusal, but the staged artifacts have already been destroyed. The
plan remains `APPROVED`; a later legitimate `commitPlan` fails with
`STAGED_PROPOSAL_MISSING`.

The rejected command changes state even though it reports `ok: false`. The same
ordering can also interfere with a plan another caller has already claimed.

## Required correction

First claim the valid `DRAFT -> REJECTED` transition. Discard proposals only
after that transition succeeds. A refused rejection must be observationally
inert.

## Regression requirement

Prepare and approve a staged plan, call `rejectPlan`, and assert the refusal does
not settle its proposal. Then commit the plan and assert that it succeeds once.
Include a concurrent reject/commit case proving that the losing operation cannot
discard artifacts owned by the winner.

## Resolution at `fa4c624`

`rejectPlan` claims the `DRAFT -> REJECTED` transition first and discards only
after it succeeds, so a refused rejection is observationally inert.

Covered by `packages/webmcp/tests/staged-lifecycle.test.ts`. Rejecting an
approved plan leaves its proposal live and the plan still commits once; that
probe fails at `0c4f2fa`.

One correction to the finding. The hypothesised interference with a plan
another caller has already claimed is not reachable through the public API.
`commitPlan` claims `APPROVED -> COMMITTING` and takes its artifacts inside
one synchronous span, so a racing `rejectPlan` always observes a plan that is
no longer `DRAFT` and finds no artifact to discard. The race is covered by a
probe that passes both before and after the fix, and is kept as a guard rather
than as a discriminating regression.
