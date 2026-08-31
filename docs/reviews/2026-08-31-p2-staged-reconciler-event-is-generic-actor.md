# P2: the staged reconciler event is typed as a generic actor

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `5a6d828`

## Finding

`runtime.reconcile` correctly passes identity through `resolveHumanActor`, but
`AuditEvent` widens `staged_reconciled.actor` back to `Actor`. TypeScript thus
permits an agent-authored reconciliation event even though the runtime method
refuses one. This repeats the type mismatch already corrected for
`rollback_reconciled`, `approvedBy`, and `reviewedBy`.

## Required correction

Type `staged_reconciled.actor` as `HumanActor` and pass the parsed actor through
without a cast or second check.

## Regression requirement

Add a compile-time assertion that an agent actor cannot populate a
`staged_reconciled` event, alongside the existing human-only event checks.

## Resolution

`staged_reconciled.actor` is typed `HumanActor`, matching `plan_approved`,
`receipt_reviewed`, and the rollback events. `runtime.reconcile` passes the
actor `resolveHumanActor` returned, with no cast and no second check. The event
also carries `resolution` rather than the old two-value `outcome`.
