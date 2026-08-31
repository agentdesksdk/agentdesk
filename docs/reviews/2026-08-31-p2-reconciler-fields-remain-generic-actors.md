# P2: reconciler fields remain typed as generic actors

Status: **OPEN**

Reviewed branch: `fix/rollback-indeterminate-and-live-announcements` at `9a808ae`

## Finding

The runtime correctly passes reconciliation through `resolveHumanActor`, but
the types discard that proof immediately afterward:

- `StoredReceipt.reconciledBy` is `Actor`.
- `ReceiptStore.reconcile(..., by)` accepts an optional `Actor`.
- The `rollback_reconciled` audit event carries `actor: Actor`.

Agent 1's rebase report says the event now carries `HumanActor`; the source
does not. TypeScript therefore permits an agent-authored reconciliation even
though the runtime public method refuses one. This repeats the human-only
record-field mismatch PR #8 already fixed for approvals and reviews.

## Required correction

Require `HumanActor` in `ReceiptStore.reconcile`, store
`reconciledBy?: HumanActor`, and type `rollback_reconciled.actor` as
`HumanActor`. Use the already parsed value from `resolveHumanActor`; do not add
another cast or runtime check.

## Regression requirement

Add a compile-time assertion that an agent actor cannot populate either the
receipt reconciler or the audit reconciler field, while the existing runtime
refusal tests continue to pass.

## Resolved

`StoredReceipt.reconciledBy`, `ReceiptStore.reconcile`'s `by` parameter, and
`rollback_reconciled.actor` are all `HumanActor`. The `reconcile` parameter
is also required rather than optional, so a reconciliation with no named
human is not constructible.

No runtime behaviour changed. `resolveHumanActor` was already producing a
parsed `HumanActor` and `reconcileRollback` was already refusing anything
else; the types just widened it back afterwards, which is why the guarantee
held in practice while the report claiming it was wrong. The parsed actor
is now passed through without a cast.

The rebase report said these fields carried `HumanActor`. They did not. That
was a statement of intent read back as if it were the code.

Compile-time regression: `packages/webmcp/tests/actor-parsing.test.ts`,
alongside the existing `approvedBy` and `reviewedBy` cases. Widening either
field back to `Actor` fails typecheck with two `TS2578: Unused
'@ts-expect-error' directive` errors, which is the check discriminating
rather than passing by default.
