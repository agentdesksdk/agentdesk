# P1: a custom scorer can bypass eligibility

Status: **OPEN**

Reviewed worktree: `crisp-grove`, commit `efb5553` (PR #12)

## Finding

`runScorer` passes the filtered `Capability[]` to untrusted scorer code, then
builds its allowlist from that same array after the scorer returns. TypeScript's
`readonly` annotation does not freeze the runtime value. A scorer can append a
capability rejected by `eligible`, throw, and make deterministic fallback rank
the rejected capability. A scorer can also return a different executable
`Capability` object with the same name as an offered one because validation is
by name and the returned object is preserved.

Both paths were reproduced against the built package. The mutation case routed
an explicitly ineligible capability after fallback. The substitution case
returned the forged object as a successful custom result.

The same boundary parser accepts duplicate capabilities and arbitrary
`reasons`, and property getters can throw after the scorer's guarded call has
finished. These are the same root defect: the scorer result is cast rather than
parsed and resolved back to canonical data.

Affected code: `packages/webmcp/src/router.ts:228-249` and
`packages/webmcp/src/router.ts:351-396`.

## Required correction

Snapshot the eligible pool before any `await`. Give the scorer detached routing
descriptors rather than executable `Capability` objects. Parse its output at the
boundary, reject duplicates and malformed fields, and resolve every accepted
identifier back to the canonical capability from the original snapshot. A
scorer failure must never mutate the pool used by deterministic fallback.

## Regression requirement

Cover an attempted pool mutation followed by fallback, same-name object
substitution, duplicate output, malformed reasons, and throwing property
getters. Every successful result must contain only the exact canonical objects
that passed `eligible`.

## Resolved

The scorer now receives a frozen copy of the pool and a frozen copy of the
request, so it cannot empty or extend the array the fallback path later
scores. Returned entries are resolved back to the capability that was
offered under that name, so an object carrying a real name and a different
`execute` never becomes the thing that runs. A name repeated twice is
refused rather than deduplicated, because a duplicate spends the budget on
one capability. A score of zero or below drops the entry, matching the
deterministic scorer.

Regression tests are in `packages/webmcp/tests/router-v2.test.ts` under
"the custom scorer boundary is not a suggestion". Reverting the frozen copy
alone fails the mutation case, checked by reverting rather than assumed.
