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

## Attempted resolution at `0887a62`

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

## Follow-up verification

The finding remains open. Freezing `[...pool]` protects only the array. Its
elements are still the live executable `Capability` objects. A scorer can
replace `offered[0].execute`, throw, and make deterministic fallback return the
mutated capability. This reproduced against the built package at `0887a62`:
both the catalog object and the fallback match carried the replacement
handler.

The scorer result is also still read through unchecked casts outside the
guarded invocation. A `score` getter that throws rejects `routeTask` with the
raw error instead of producing the configured structured refusal. Malformed
`reasons` are silently replaced rather than rejected. The original requirement
to give the scorer detached routing descriptors and parse its output therefore
still stands. The frozen array and canonical name lookup are useful partial
fixes, but they do not form the trust boundary described by this record.

## Reopened, then resolved properly

The first fix was wrong and the report on it was worse. `Object.freeze` on a
copied array freezes the array, not the capabilities inside it, so a scorer
still held live `execute`, `availability`, and `verify` functions on the
real objects. I described that as a boundary. It was a fence around the
wrong thing.

The scorer now receives `RoutingDescriptor` objects carrying name,
description, risk, and routing metadata and none of the functions, and it
answers with `ScoredDescriptor`, which is a name and a number. There is no
handler to replace and nothing to forge, so the previous name-check is now
a lookup rather than a validation.

The call and the parse share one guard. Reading `score` can invoke a getter,
and a getter that throws outside the guard escaped as a raw rejected promise
from a method whose type promises `{ ok: false, reason }`.

Regression tests are in `packages/webmcp/tests/router-v2.test.ts` under
"the scorer never touches an executable capability". Reverting the
descriptor mapping fails two of them.

## Follow-up verification at `8f7de87`

The descriptor change removes live capabilities and the shared guard converts
throwing output getters into structured failures. The boundary is still open
through `RoutingRequest`. `Object.freeze({ ...request })` is shallow, so the
scorer receives the caller's live `context` object, `context.state`, and
`session` array.

This reproduced against the built package. A scorer set
`received.context.state.approved = true`, appended to `received.session`, then
threw. The caller's application state and original session were both changed,
and deterministic fallback proceeded afterward. The scorer input must own a
detached read-only request snapshot as well as detached capability descriptors.
Do not deep-freeze caller-owned objects in place; clone the state the scorer is
allowed to observe and freeze the owned copy.

## Reopened again, then closed

Descriptors fixed the capability side and left the request side open.
`Object.freeze({ ...request })` seals one level, so `context`,
`context.state`, and `session` were still the caller's objects. A scorer
could set `context.state.approved` and push to the session array, and both
survived the fallback.

The scorer now receives a `RoutingRequestSnapshot`: query, route, optional
domain, `contextKeys`, session, and limit, all owned and frozen. Nothing in
it aliases the caller.

`contextKeys` lists which state keys are set and never their values. That is
a deliberate narrowing rather than a copy. Routing only asks whether an
entity is present, and this seam is the one most likely to become a remote
call, so a customer email sitting in `state` should not travel to an
embedding service because some capability declared an entity. A probe
confirms the serialized snapshot contains `orderId` and not the address.

Malformed `reasons` are refused rather than replaced. Absent still defaults,
because that means no explanation was offered. Present and malformed means
the scorer is wrong about its own output, and quietly substituting a
plausible reason would fabricate an explanation in the field that exists to
explain.

Reverting `router.ts` to the previous commit fails all three regression
tests. This time the revert was `git stash` of the whole file rather than a
hand-edited string, after two earlier approximate reverts in this review
cycle silently proved nothing.
