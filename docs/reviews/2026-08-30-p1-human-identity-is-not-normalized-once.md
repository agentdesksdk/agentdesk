# P1: A caller-supplied human identity is not normalized once

Status: RESOLVED on `fix/acting-identity`

Reviewed commit: `2bc6f6a`

Validated: `packages/webmcp/tests/identity-boundaries.test.ts` passed on
`fix/acting-identity`, 6 of 6, alongside the full 339-test suite. `ownActor`
now returns a discriminated result rather than throwing, and a single
`resolveHumanActor` helper snapshots the caller's object, refuses on a clone
failure, and narrows the snapshot to `HumanActor`. `approvePlan` and
`markReviewed` both call it before validating and before any state
transition, then use that one snapshot for the record and the audit event.
The uncloneable approver now returns `{ ok: false, reason }`, the plan stays
in DRAFT with no `approvedBy`, and no `plan_approved` event is appended. The
uncloneable reviewer refuses the same way. The getter-backed actor is read
exactly once, by `structuredClone`, so it is approved as a human and
recorded as a human.

## Finding

`approvePlan` resolved its approver as `by ?? actor`, validated
`.kind === "human"` on the caller's live object, claimed the DRAFT to
APPROVED transition, and only then stored the identity. `markReviewed` had
the identical shape. Two defects follow from that ordering.

The `kind` check reads the caller's object, and every later read reads it
again. A getter-backed actor can answer `"human"` to the check and `"agent"`
to `plans.resolve` and the audit append. The plan is approved on the
strength of a claim that the recorded value contradicts, and the audit
stream carries the contradiction as fact.

`structuredClone` throws `DataCloneError` on an actor carrying a function.
The clone happened downstream in `PlanStore.resolve`, after the transition
had already been claimed. The throw escaped `approvePlan`, leaving the plan
in APPROVED with no approver recorded and no `plan_approved` event. The plan
is then committable, and nothing in the record says who authorized it.
`markReviewed` stranded the same way inside `ReceiptStore.markReviewed`.

## Evidence

A deterministic probe called `approvePlan` with an approver carrying a
function property.

Observed result:

```json
{ "thrown": "DataCloneError", "status": "APPROVED", "approvedBy": null, "audited": false }
```

An approval that failed left the plan approved by nobody.

## Affected code

- `packages/webmcp/src/runtime.ts`, `ownActor`
- `packages/webmcp/src/runtime.ts`, `approvePlan()`, `const approver = by ?? actor`
- `packages/webmcp/src/runtime.ts`, `markReviewed()`, `const reviewer = by ?? actor`
- `packages/webmcp/src/plan.ts`, `PlanStore.resolve()`, `structuredClone(patch)`
- `packages/webmcp/src/receipts.ts`, `ReceiptStore.markReviewed()`, `structuredClone(by)`

## Required behavior

- Take one snapshot of the caller-supplied identity before validating and before any state transition.
- Return a structured refusal when the identity cannot be cloned, naming that reason, rather than throwing out of a half-applied transition.
- Validate `kind` on the snapshot, never on the caller's object.
- Use that same snapshot for the stored record and for the audit event, so there is exactly one identity value and the caller's object is never read again.
- Own the clone failure in one helper so `approvePlan` and `markReviewed` cannot diverge.

## Regression test

Call `approvePlan` with an approver carrying a function property. Assert the
result is `{ ok: false }`, the plan is still DRAFT, `approvedBy` is
undefined, and no `plan_approved` event was appended. Call `markReviewed`
with the same object and assert it refuses with no `reviewedAt` and no
`receipt_reviewed` event. Separately, approve with an actor whose `kind`
getter answers `"human"` once and `"agent"` afterwards, and assert the
outcome is self-consistent: either refused with the plan left in DRAFT, or
accepted with `human` on both the plan and the audit event.
