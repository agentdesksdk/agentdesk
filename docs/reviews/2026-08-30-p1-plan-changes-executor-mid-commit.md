# P1: A plan changes executor mid-commit

Status: RESOLVED on `fix/acting-identity`

Reviewed commit: `2bc6f6a`

Validated: `packages/webmcp/tests/identity-boundaries.test.ts` passed on
`fix/acting-identity`, 6 of 6, alongside the full 339-test suite.
`commitPlan` resolves the executor once, immediately after the plan wins the
APPROVED to COMMITTING transition, and passes it through `commitOperation`
into `executeNow` for every operation in the commit. The two-operation probe
that produced the evidence below now reports `agent-a` on both receipts.

## Finding

`commitPlan` claims the COMMITTING transition and then loops over the
operations calling `commitOperation`, which called `executeNow` with no
actor. Each operation therefore resolved the ambient actor independently,
at the moment it happened to reach the execution.

`commitPlan` awaits each operation in turn. A `setActor` while an earlier
operation is suspended is visible to every operation after it. One plan
commit then produces receipts naming different executors, which contradicts
the thing a plan is for. The human approved one unit of work, and the record
of who performed it is not one answer.

The plan's own status is unaffected, so the commit reports success while
carrying inconsistent provenance.

## Evidence

A deterministic probe prepared a two-operation plan, approved it as a human,
started the commit, called `setActor(agent-b)` while the first operation was
suspended on a gate, then released the gate.

Observed result:

```json
{
  "status": "COMMITTED",
  "receipts": [["second_write", "agent-b"], ["first_write", "agent-a"]]
}
```

One COMMITTED plan, two executors.

## Affected code

- `packages/webmcp/src/runtime.ts`, `commitPlan()`, the `for (const operation of claimed.operations)` loop
- `packages/webmcp/src/runtime.ts`, `commitOperation()`, `executeNow(routed, operation.input, { planId })`

## Required behavior

- Resolve the executor once per commit, immediately after the plan claims COMMITTING.
- Pass that value through `commitOperation` into every operation's execution.
- Let a `setActor` during a commit affect only work started after the commit ends.
- Keep the executor distinct from `requestedBy` and `approvedBy`, which the plan already records separately.

## Regression test

Prepare a two-operation plan where the first operation suspends on a gate.
Approve it as a human and start the commit. Call `setActor(B)` while the
first operation is suspended, then release it. Assert that the set of
`executedBy` ids across the commit's receipts is exactly `{A}`.
