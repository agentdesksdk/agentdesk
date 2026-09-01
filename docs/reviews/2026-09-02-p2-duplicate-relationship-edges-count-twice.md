# P2: duplicate relationship edges are counted twice by the hybrid scorer

Status: **RESOLVED**

Reviewed `origin/main` at `87e6d6e` (PR #12). Tracked as issue #16.

## Finding

`defineCapability` copies and freezes `requires` and `related` but does not
deduplicate, and `hybrid` accumulates once per entry:

```text
requires: ["target_task", "target_task"]
TARGET_SCORE 8  reasons ["deterministic","required by anchor_task","required by anchor_task"]
```

One relationship contributed twice, enough to outrank a genuine exact-term
match at 6. It needs an authoring mistake, but generated manifests are
where duplicates arrive.

## Required correction

Deduplicate in the normalization `defineCapability` already owns, so the
scorer needs no change.

## Regression requirement

A capability with a duplicated `requires` entry, routed with `hybrid`,
asserting the target's score counts the relationship once and `reasons`
names it once.

## Resolution

Both arrays pass through a `Set` before being frozen. Covered by the
"counts a relationship once" case in `packages/webmcp/tests/router-v2.test.ts`,
which fails against the previous normalization.
