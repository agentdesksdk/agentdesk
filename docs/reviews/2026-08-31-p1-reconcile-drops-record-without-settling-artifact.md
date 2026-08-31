# P1: reconcile drops the record without settling the artifact

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `5a6d828`

## Finding

The runtime says the staged artifact is retained as evidence and describes
`reconcile` as the exit from the unknown state. The `Unreconciled` record does
not retain the artifact or a recovery closure, however. `reconcile` only
removes metadata and appends `staged_reconciled`; it never asks the adapter to
finalize, abandon, or otherwise settle the artifact.

This was reproduced against the built package. After an indeterminate commit,
the adapter reported one open artifact. `reconcile(actionId, "applied",
HUMAN)` returned `{ ok: true }` and removed the record, while the adapter still
reported the same open artifact. The cleanup-failure path has the same shape
and carries neither an artifact handle nor approved changes.

The outcome vocabulary is also too narrow for cleanup failure. `applied` and
`not_applied` answer whether a write landed; neither says whether a failed
disposal was retried successfully.

## Required correction

Make reconciliation a real adapter boundary. Retain an opaque recovery handle
or adapter-owned record key, and give the adapter a typed reconciliation or
finalization hook whose successful return establishes the artifact's terminal
state. Keep the record open if recovery fails. Model cleanup recovery
separately from commit application when their outcomes differ.

## Regression requirement

Reconcile both an indeterminate commit and a failed cleanup. Assert the adapter
observes the requested recovery, the artifact becomes terminal exactly once,
and a throwing recovery leaves the record open with the original evidence.

## Resolution

Reconciliation is a real adapter boundary now. `StagedProposal`,
`StagedCommitIndeterminate`, and `CleanupFailure` all carry the adapter's
opaque artifact; `UnreconciledStore` holds it privately and never hands it
out. `StagingAdapter.reconcile(staged, resolution)` is a required hook, and
only its successful return settles the record. A throw appends
`staged_reconcile_failed` and leaves the record and its evidence untouched.

Commit application and cleanup disposal no longer share a vocabulary.
`StagedResolution` is `commit_applied`, `commit_not_applied`, or
`cleanup_disposed`, so a failed disposal that later succeeded is not described
as a write that landed.

Covered by three probes: settling an indeterminate commit, a throwing recovery
that keeps the record and the original changes, and settling a cleanup failure
through its own resolution.
