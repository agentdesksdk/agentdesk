# P1: Reset allows in-flight plans and rollbacks to repopulate audit state

Status: RESOLVED in `bf079ca`. `f7c6d1f` closed only the two reported probes; see the correction below for what it left open.

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


## Resolution

`claimSession()` names the epoch an operation belongs to. `runExecution`
already compared epochs inline; `commitPlan` and `rollback` did not check at
all. All three now claim a session and recheck it after every await, so a
handler that resolves after `reset()` cannot write into the cleared one.

Both probes in this finding are now regression tests. Reset during a plan
commit leaves plans, receipts, and audit empty, and reset during a rollback
additionally makes the rollback report failure rather than claiming success
against a receipt that no longer exists.

This is proven at the unit level, where a handler can be held open across the
reset. The demo has no capability slow enough to hold that window open
through the UI.

## Correction: still OPEN

Marking this RESOLVED in `f7c6d1f` was wrong. That commit gave `commitPlan`
and `rollback` a session claim, which closed the two probes recorded above.
It did not make reset a session boundary. Three further paths cross it, each
confirmed by probe against `f7c6d1f`:

- The claim is checked after `capability.execute` but not after
  `runVerification`. Reset during verification recreates both the completion
  audit event and the receipt, and the call still returns success.
- `commitPlan` checks its claim only after running every operation. Reset
  during operation one leaves operation two to execute in the new session.
  Observed `ran: ["one", "two"]` with `execution_started` and
  `execution_completed` in an audit that reset had emptied.
- `approve` awaits execution without owning a claim, then resolves the
  approval unconditionally. After reset, `get_action_status` for the cleared
  `APR-1001` still returns a record.

The pattern is that a claim checked at some awaits is not a boundary. It has
to travel with the operation, including into nested plan operations, and the
stores have to refuse writes from an expired one.

### Re-review: prepare can recreate a plan during reset

`prepare()` owns no session claim. A capability's synchronous
`previewChanges` callback called `reset()`. Reset cleared plans before its
first await, then `prepare()` created `PLAN-1` after that clear. When reset
finished, the plan remained while the reset's final audit clear removed its
`plan_prepared` event:

```json
{
  "preparedId": "PLAN-1",
  "storedPlans": ["PLAN-1"],
  "auditKinds": []
}
```

Claim the session at the start of `prepare` and refuse to create or audit a
plan if any application callback ends that session. Add this callback-driven
reset case to the regression suite.

## Resolution in `bf079ca`

Every path that crosses an await now carries the claim it started with, and
each of the probes above is a regression test in
`packages/webmcp/tests/session-and-finalization-integrity.test.ts`.

- `runExecution` rechecks after `runVerification`, not only after the handler.
- `commitPlan` checks before each operation rather than after all of them, so
  the operation following an interrupted one never starts.
- `prepare` holds a claim across `previewChanges` and `revision`, and refuses
  to create a plan whose session ended while those callbacks ran.
- `approve` holds a claim across execution. `ApprovalManager.resolve` inserts
  rather than updates, which is why resolving after a reset was putting the
  cleared action back.

Not covered. A capability handler that mutates the application and then has
its session ended still made that change; the runtime refuses to record it,
which is the honest outcome, but it cannot undo it.
