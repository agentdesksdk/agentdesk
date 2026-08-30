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
