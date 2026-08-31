# P1: stop strands an interrupted rollback in progress

Status: **PARTIALLY FIXED** in `bf079ca`

Reviewed branch: `fix/reset-epoch-and-approval-identity` at `104149e`

## Finding

`rollback()` claims the receipt as `ROLLING_BACK`, but every post-await
session-expiry branch returns without settling that claim. `reset()` hides
the defect by clearing receipts. `stop()` advances the same epoch without
clearing receipts, so the receipt stays permanently in progress.

Observed after stopping while the rollback handler awaited:

```json
{
  "outcome": {
    "ok": false,
    "reason": "RCPT-1 belongs to a session that was reset"
  },
  "rollbackState": "ROLLING_BACK"
}
```

The reason is also inaccurate because the runtime was stopped, not reset.
Every later rollback is refused as already running, although no rollback is
running anymore.

## Required correction

Settle an interrupted rollback according to where interruption occurred. If
the session expires before dispatch, release the receipt to `READY`. If it
expires after the compensating action was dispatched, record an indeterminate
outcome that requires reconciliation. PR #9 already defines that evidence
model, so the eventual rebase should use it rather than inventing a second
state machine. Return a neutral stopped-or-reset reason.

## Regression requirement

Pause a rollback handler, call `stop()`, release the handler, and assert that
the receipt does not remain `ROLLING_BACK`. A second call must receive the
settled rollback state, not an "already being rolled back" refusal.

## Re-review at `fc4ae0a`

The receipt is no longer stranded, but the required post-dispatch evidence
model is not implemented. After `stop()` releases a successful compensating
handler, the receipt is changed to `ROLLED_BACK`, the caller receives
`RCPT-1 belongs to a session that was reset`, and the audit contains no
`rollback_performed` event:

```json
{
  "rollbackState": "ROLLED_BACK",
  "rollbackEvents": [],
  "reason": "RCPT-1 belongs to a session that was reset"
}
```

That closes the permanent `ROLLING_BACK` lock but creates an unaudited state
transition and misreports `stop()` as `reset()`. Keep this finding open until
the PR #9 evidence model is composed on rebase: a dispatched rollback whose
session ends must settle with explicit evidence or an indeterminate state,
and the audit, receipt, and returned reason must agree.

## Resolved on PR #9, rebased onto `6a2d7f1`

The remaining half was that receipt state, audit evidence, and the returned
result disagreed. After #10, a compensating action that completed while its
session was ending marked the receipt `ROLLED_BACK`, wrote no
`rollback_performed` event because the session could no longer be written
to, and returned `ok: false`. Three sources, three different answers, and
the receipt was the one claiming the strongest thing on the least evidence.

A session that ends after dispatch is the same epistemic position as a
handler that throws after dispatch. The compensating action ran and nothing
can be recorded about what it did. So it takes the same state. The receipt
becomes `INDETERMINATE` carrying `rollbackAttemptedAt` and a
`rollbackFailure` naming the session, no audit event is written because
none can be, the caller is told the undo is unreconciled rather than failed,
and `reconcileRollback` is available to settle it once a human has looked.

A throwing rollback interrupted the same way records the underlying failure
and the session in one `rollbackFailure`, rather than losing the original
error behind the session message.

Regression test: `packages/webmcp/tests/rollback-session-seam.test.ts`, six
cases across stop and reset. Two of them fail against the pre-fix behaviour
with `expected 'ROLLED_BACK' to be 'INDETERMINATE'`; the other four are
regression guards for properties #10 already satisfied.
