# P1: an invalid routing limit bypasses the hard budget

Status: **OPEN**

Reviewed worktree: `crisp-grove`, commit `efb5553` (PR #12)

## Finding

`routeTask` computes `Math.min(request.limit, MAX_ROUTED)` without validating
the caller's number. A negative limit reaches `slice(0, -1)`, which means "all
but the last item" rather than zero or a refusal. With twenty custom-scored
candidates and `limit: -1`, nineteen can be returned despite the stated hard
maximum of six. `NaN` and fractional values also receive accidental JavaScript
slice semantics instead of an explicit routing contract.

This was reproduced against the built package with three candidates and
`limit: -1`; two matches were returned.

Affected code: `packages/webmcp/src/router.ts:226-227` and every later
`slice(0, budget)`.

## Required correction

Normalize `limit` once at the public boundary. Accept only a finite,
non-negative integer, define zero explicitly, and clamp valid values to
`MAX_ROUTED`. Invalid input must return a structured refusal or use a clearly
documented safe default; it must never weaken the maximum.

## Regression requirement

Cover `-1`, `NaN`, positive fractions, zero, and values above `MAX_ROUTED` on
deterministic, hybrid, successful custom, and custom-fallback paths. No result
may exceed the hard maximum.

## Resolved

`clampBudget` replaces the bare `Math.min`. The cap is
`max(0, min(floor(limit), MAX_ROUTED))`, and a non-finite limit falls back
to the default rather than propagating.

The bug was that a budget was being treated as an argument to `slice`.
`slice(0, -1)` drops one entry and returns the rest, so `limit: -1`
published 14 of 15 capabilities. Reverting the clamp reproduces exactly
that: `expected 14 to be less than or equal to 6`.
