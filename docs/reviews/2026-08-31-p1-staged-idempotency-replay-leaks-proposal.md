# P1: staged idempotency replay leaks a proposal

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `0c4f2fa`

## Finding

The direct staged path calls `stageFor` before `executeNow`. Idempotency is
claimed inside `executeNow`, so a replay or concurrent duplicate creates a new
proposal before the runtime discovers the previous execution. The replay then
returns the prior successful result with `ok: true`, and `runCapability`
discards proposals only when `outcome.ok` is false.

The new proposal is never committed or discarded. In the demo adapter it stays
in the global `live` set, so a successful idempotent replay leaves a visible
ghost and retained branch. Concurrent duplicates can create one leaked proposal
per losing call even though the write commits once.

## Required correction

Claim or join the idempotency slot before staging. Only the winning execution
may create the proposal. A replay should return the stored result without
calling the stage handler, and a conflicting/capacity refusal should not stage
anything.

## Regression requirement

Cover sequential replay and concurrent duplicate calls to an unapproved staged
write. Assert that staging runs once, commit runs once, the returned results are
deduplicated, and no proposal remains live. Also cover a key reused with
different input and capacity refusal; neither may stage.

## Resolution at `fa4c624`

`claimIdempotency` is synchronous and runs before `stageFor` on the direct
path, so only the winner stages. A replay returns the stored result without
calling the handler; a fingerprint conflict and a capacity refusal both return
before anything is forked. The claim is passed into `executeNow` rather than
made there, so the slot is claimed exactly once. A staging failure after the
claim settles the slot, so a refusal cannot strand it in flight.

Covered by `packages/webmcp/tests/staged-lifecycle.test.ts`: sequential
replay, three concurrent duplicates, a key reused with different input, and
600 concurrent distinct keys against a bound of 512. Each asserts the stage
count and that no proposal is left live. All four fail at `0c4f2fa`.
