# P1: a staged commit can land and be recorded as failed

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `0123fbc`

## Finding

`buildStageHandler` catches every exception from `adapter.commit`, releases the
artifact, and rethrows. `runExecution` then records `execution_failed`, and the
approval resolves as `FAILED`. An exception proves only that `commit` did not
return. It does not prove the application write did not land.

This was reproduced against the built package with an adapter whose `commit`
copies the staged head into live state and then throws `commit acknowledgement
failed`. After approval, live state was changed, `release` had been called,
`get_action_status` returned `FAILED`, and the audit contained
`execution_failed`. The artifact and the only staged evidence were discarded
at the point where the outcome became uncertain.

This is the same epistemic boundary already modeled for rollback: a dispatched
operation that throws can have committed. Reporting it as a clean failure makes
a manual retry capable of applying the write twice.

## Required correction

Do not infer a pre-commit failure from an exception. A commit that throws after
dispatch must become an explicit indeterminate execution, retain enough
evidence for reconciliation, and refuse automatic retry. Alternatively, the
adapter protocol must return a typed outcome that distinguishes a refusal
before dispatch from an unknown result after dispatch; ordinary error text is
not sufficient evidence.

## Regression requirement

Add an adapter whose `commit` mutates live state and then throws. The approval
and audit must not say `FAILED`, the artifact must not be silently released as
though nothing landed, and the runtime must expose a reconciliation path or an
equally explicit indeterminate terminal state.

## Resolution at `fb76baf`

A thrown commit is no longer read as a clean failure. `buildStageHandler`
wraps it in `StagedCommitIndeterminate`, keeps the artifact rather than
releasing it, and carries the approved diff. The approval resolves
`INDETERMINATE`, the audit records `execution_indeterminate`, and
`get_action_status` returns the detail, the record id, the approved changes,
and an explicit instruction not to retry. `listUnreconciled` holds it until a
human calls `reconcile(target, "applied" | "not_applied", by)`, which requires
a human actor and writes `staged_reconciled`.

An adapter that knows nothing was dispatched says so with
`StagedCommitRefused` or `CapabilityUnavailableError`; both stay ordinary
refusals and release normally. That is the typed distinction between a refusal
before dispatch and an unknown result after it. The demo's stale-merge refusal
uses it.

Covered by four probes in `packages/webmcp/tests/staged-operations.test.ts`
with an adapter whose commit writes live state and then throws.
