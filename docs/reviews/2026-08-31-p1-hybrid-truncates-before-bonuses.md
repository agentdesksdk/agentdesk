# P1: hybrid routing truncates deterministic scores before adding bonuses

Status: **OPEN**

Reviewed worktree: `crisp-grove`, commit `efb5553` (PR #12)

## Finding

Hybrid routing does not score the full eligible pool. Its deterministic base
calls `rankCapabilities(..., MAX_ROUTED)`, so every candidate below the first
six loses its lexical score before exact-name, session, and relationship
bonuses are added. A seventh-ranked prerequisite with one deterministic point
therefore receives only its relationship bonus. It can tie and lose to an
unrelated candidate that it should outrank when the promised additive score is
calculated correctly.

The seven-candidate case was reproduced. The required capability was omitted
because its base score was discarded before the relationship walk.

Affected code: `packages/webmcp/src/router.ts:253-266` and
`packages/webmcp/src/router.ts:270-339`.

## Required correction

Compute deterministic scores for every positive-scoring eligible candidate,
apply hybrid contributions to that complete score set, order once, and enforce
the output budget only at the end. Relationship edges remain weighted hints;
this finding does not require reserving a slot for every prerequisite.

## Regression requirement

Use more than `MAX_ROUTED` eligible candidates. Put a candidate below the
initial deterministic cutoff whose base score plus one hybrid bonus should move
it into the final result. Assert both the final membership and the complete
additive score.

## Resolved

Scoring is split from trimming. `scoreAll` returns the ranked pool with no
budget applied, `rankCapabilities` is `scoreAll` plus the same slice it
always had, and hybrid consumes `scoreAll` so a capability ranked seventh
keeps its base score when its relationship bonus is added.

The regression test uses eight capabilities that all match weakly, so the
deterministic top six is full before the graph is consulted, and the anchor
requires the one an early truncation would have discarded. It asserts the
score is 5, the keyword base of 2 plus the requires bonus of 3, rather than
the bonus alone. Reverting gives `expected 3 to be 5`.
