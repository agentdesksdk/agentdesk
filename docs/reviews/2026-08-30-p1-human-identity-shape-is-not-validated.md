# P1: human identity shape is not validated at the JavaScript boundary

Status: **PARTIALLY FIXED on `fix/acting-identity`**

Reviewed branch: `fix/acting-identity` at `d7a4911`

Validated: `packages/webmcp/tests/actor-parsing.test.ts` passed on
`fix/acting-identity`, 4 of 4, alongside the full 343-test suite. A
`parseActor(value: unknown)` function now sits beside `Actor` in
`packages/webmcp/src/plan.ts` and is exported from the package. It refuses a
non-object, a missing or non-string or empty or blank `id`, a `kind` outside
`"agent" | "human" | "system"`, and a `name` that is present but not a
string, each with a reason naming what was wrong. On success it rebuilds the
actor from the fields it checked rather than passing the caller's object
through, so an extra property cannot ride along. `resolveHumanActor` now
snapshots with `ownActor`, parses that snapshot, and only then applies
`isHumanActor`, all before any state change. Every one of the eight
malformed approvers refuses, leaves the plan in DRAFT with no `approvedBy`,
and appends no `plan_approved` event; the eight malformed reviewers refuse
the same way with no `reviewedAt` and no `receipt_reviewed` event.


Follow-up, the ambient path. The first fix parsed only the identities that
record a human decision. `adoptActor` still cloned and froze without
parsing, so constructor configuration and `setActor` both accepted
`{ kind: "agent" }` with no id and the execution audit recorded it.
`packages/webmcp/tests/ambient-actor-parsing.test.ts` reproduces it on
`8050009`, where an anonymous identity reaches a completed execution as
`expected undefined to be 'agent-a'`. `adoptActor` now parses the snapshot
and throws `TypeError` on a malformed shape, which is the behavior it
already had for an identity that could not be cloned, so no API changed.
All 347 tests pass.

## Re-review at `748b4c5`

The human-decision paths are fixed, but the required constructor and
`setActor` paths still bypass `parseActor`. Both accepted `{ kind: "agent" }`
with no `id`, and `execution_started` recorded that anonymous actor:

```json
{
  "constructorActor": { "kind": "agent" },
  "constructorAuditActor": { "kind": "agent" },
  "setterThrew": false,
  "setterActor": { "kind": "agent" },
  "setterAuditActor": { "kind": "agent" }
}
```

This needs no setter signature change. `setActor` already throws `TypeError`
through `adoptActor` when cloning fails. Parse the owned value in
`adoptActor` and use the same existing failure behavior for malformed shape.

## Finding

`resolveHumanActor` clones the supplied value and checks only `kind === "human"`. It assumes TypeScript already established the rest of `Actor`, but the published SDK is callable from JavaScript. A caller can omit the required `id` and still authorize a plan.

Observed with the built package:

```json
{
  "resultOk": true,
  "status": "APPROVED",
  "approvedBy": { "kind": "human" },
  "auditActor": { "kind": "human" }
}
```

The plan and audit say a human approved the operation but cannot identify who. This defeats the provenance claim the approval record exists to provide.

## Required correction

Parse the complete actor shape at the public boundary before narrowing it. Require a non-empty string `id`, an allowed `kind`, and a string `name` when present. Use the parsed owned value for validation, storage, and audit. Apply the same parser to initial actor configuration and `setActor` so actor validity does not depend on which entry point supplied it.

## Regression requirements

- `approvePlan(planId, { kind: "human" })` returns a structured refusal and leaves the plan `DRAFT`.
- Missing, empty, and non-string ids cannot enter approval, review, execution, receipt, presentation, or audit records.
- A malformed optional name is refused rather than recorded.
