# P1: revision drift leaves staged proposals alive

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `0c4f2fa`

## Finding

`commitPlan` resolves a revision mismatch to terminal state `DRIFTED` and
returns without calling `proposals.discardPlan(planId)`. No later plan operation
can consume those artifacts, so every staged proposal for the plan remains
reachable indefinitely. In the demo adapter the corresponding branches remain
in its `live` set and can continue to appear as staged ghosts.

This contradicts the stated lifecycle guarantee that every terminal path either
commits or discards its proposal.

## Required correction

Discard the plan's staged proposals as part of the same terminal drift path,
before returning. Keep the plan and audit record available, but release the
uncommittable artifacts exactly once.

## Regression requirement

Prepare and approve a staged plan, change the application revision, and attempt
commit. Assert the plan is `DRIFTED`, no write lands, every proposal is settled,
and the adapter reports zero live staged ghosts.

## Resolution at `fa4c624`

The drift branch calls `proposals.discardPlan(planId)` before resolving the
plan to `DRIFTED` and returning. The plan and its audit record stay available;
only the uncommittable artifacts are released, exactly once.

Covered by `packages/webmcp/tests/staged-lifecycle.test.ts`, which moves the
revision under an approved plan and asserts `DRIFTED`, no write, no commit,
and zero live proposals. It fails at `0c4f2fa`.
