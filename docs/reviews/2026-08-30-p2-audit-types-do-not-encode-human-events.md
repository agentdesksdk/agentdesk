# P2: Audit types do not encode the human-only events

Status: RESOLVED on `fix/acting-identity`

Reviewed commit: `2bc6f6a`

Validated: `packages/webmcp/tests/identity-boundaries.test.ts` passed on
`fix/acting-identity`, 6 of 6, alongside the full 339-test suite, and all
three TypeScript projects typechecked. `HumanActor` and the `isHumanActor`
predicate live beside `Actor` in `packages/webmcp/src/plan.ts` and are
exported from the package index. `plan_approved` and `receipt_reviewed`
declare `actor` as required and typed `HumanActor`. The validation in
`approvePlan` and `markReviewed` narrows through `isHumanActor` rather than
asserting, so the compiler proves the contract instead of taking it on
trust. No `as HumanActor` exists anywhere. The three casts in
`packages/webmcp/tests/acting-identity.test.ts` that only existed to work
around the weak type are gone, and those assertions still pass.

## Finding

`plan_approved` and `receipt_reviewed` declared `actor?: Actor`. Both are
only ever emitted with an identity the runtime has already validated as a
human, so the declared type is weaker than the guarantee in two directions
at once. It says the field may be absent when it never is, and it says the
actor may be an agent or a system when it never is.

The cost lands on consumers. Reading the approver off a `plan_approved`
event required a cast to reach a field the runtime always sets, and the cast
also discarded the human guarantee that is the entire point of the event.
The two events that exist to record a human decision were the two the type
system said nothing about.

The weakness fed back into the runtime. `approvePlan` and `markReviewed`
checked `kind === "human"` and then passed a plain `Actor` onward, so
nothing connected the check to the record.

## Evidence

`packages/webmcp/tests/identity-boundaries.test.ts` reads
`event.actor.kind` after narrowing on `event.kind`, which is the natural way
to consume a discriminated union. It failed to compile:

```text
tests/identity-boundaries.test.ts(183,16): error TS18048: 'event.actor' is possibly 'undefined'.
tests/identity-boundaries.test.ts(186,16): error TS18048: 'event.actor' is possibly 'undefined'.
```

Line 183 is `plan_approved` and line 186 is `receipt_reviewed`. A consumer
cannot read the human off either event without either a cast or a null check
for a case that cannot occur.

## Affected code

- `packages/webmcp/src/audit.ts`, `plan_approved`, `actor?: Actor`
- `packages/webmcp/src/audit.ts`, `receipt_reviewed`, `actor?: Actor`
- `packages/webmcp/src/plan.ts`, `Actor`
- `packages/webmcp/src/runtime.ts`, the `kind !== "human"` checks in `approvePlan()` and `markReviewed()`
- `packages/webmcp/tests/acting-identity.test.ts`, the `as { actor?: ... }` casts

## Required behavior

- Define `HumanActor` beside `Actor` and export it from the package index.
- Make `actor` required and typed `HumanActor` on `plan_approved` and `receipt_reviewed`.
- Narrow to `HumanActor` with a type predicate in the runtime so the compiler proves the events cannot carry a non-human, rather than asserting with `as`.
- Leave `actor` optional and typed `Actor` on `execution_started`, `execution_completed`, `execution_failed`, and `rollback_performed`, which legitimately carry agents.
- Delete the consumer casts the weak type forced.

## Regression test

Iterate `getSnapshot().audit`, narrow on `event.kind`, and read
`event.actor.kind` on `plan_approved` and on `receipt_reviewed` with no cast
and no optional chaining. The assertion is that the file compiles under
`tsc --noEmit` as much as that it passes at runtime.
