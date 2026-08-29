# P1: Reset allows in-flight plans and rollbacks to repopulate audit state

Status: OPEN

Reviewed commit: `812e5b9`

## Finding

`reset()` clears plans, receipts, and audit state, but `commitPlan()` and `rollback()` do not participate fully in the runtime epoch. An operation that was already in flight can finish after reset and append a terminal audit event into the clean session.

The plan path notices cancellation only inside `runExecution()`. Its outer `commitPlan()` still appends `plan_failed` after reset. The rollback path has no epoch check, so it returns success and appends `rollback_performed` even though reset removed the receipt.

Reset is not a reliable session boundary while these operations are active.

## Evidence

### Plan commit

A plan handler was paused after `commitPlan()` claimed the plan. The runtime was reset, then the handler was released.

```json
{
  "outcome": {
    "ok": false,
    "reason": "1 of 1 operations failed: slow_plan_write (EXECUTION_CANCELLED)"
  },
  "plans": [],
  "receipts": [],
  "audit": ["plan_failed"]
}
```

### Rollback

A rollback handler was paused after the receipt was claimed. The runtime was reset, then the rollback was released.

```json
{
  "outcome": {
    "ok": true,
    "result": { "restored": true }
  },
  "plans": [],
  "receipts": [],
  "audit": ["rollback_performed"]
}
```

Both probes start with an empty audit immediately after reset. The listed event arrives from the prior session.

## Affected code

- `packages/webmcp/src/runtime.ts`, `reset()`
- `packages/webmcp/src/runtime.ts`, `commitPlan()`
- `packages/webmcp/src/runtime.ts`, `rollback()`

## Required behavior

- Capture the current epoch when plan commit and rollback begin.
- After every awaited boundary, refuse to mutate runtime state when the epoch changed.
- Do not append plan or rollback events from an operation that belongs to the prior epoch.
- Define what reset does to an already-running compensating action. If the application write cannot be cancelled, return an indeterminate outcome without contaminating the new session.
- Keep plans, receipts, and audit empty after reset even when old work resolves later.

## Regression tests

Add two deferred-handler tests:

1. Start `commitPlan()`, reset while its operation awaits, then release it. Assert that plans, receipts, and audit remain empty.
2. Start `rollback()`, reset while its compensating action awaits, then release it. Assert that receipts and audit remain empty and that the outcome does not claim a tracked success in the new session.

