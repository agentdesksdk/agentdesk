# P1: reconciliation accepts a contradictory resolution

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `d43ae10`

## Finding

The new vocabulary distinguishes an unknown commit from a failed cleanup, but
the runtime does not enforce that distinction. `reconcile` accepts every
`StagedResolution` for every `Unreconciled.kind` and immediately hands it to
the adapter.

This was reproduced against the built package by reconciling a
`commit_indeterminate` record with `{ kind: "cleanup_disposed" }`. The adapter
accepted it, the runtime returned `{ ok: true }`, and the only record of the
unknown write was deleted. A JavaScript caller can also pass an arbitrary
unrecognized `kind` because the public boundary performs no runtime parsing.

## Required correction

Validate resolution shape and compatibility before calling the adapter.
`commit_indeterminate` may accept only `commit_applied` or
`commit_not_applied`; `cleanup_failed` may accept only `cleanup_disposed`.
Refuse unknown fields or kinds without changing the artifact or record.

## Regression requirement

Exercise every invalid record/resolution pairing and an unknown JavaScript
kind. Each must return a structured refusal, not call the adapter, and leave
the record and evidence unchanged.

## Resolution

`parseResolution` runs before the adapter is touched. It parses the value as a
JavaScript caller could supply it, rejecting a non-object, extra fields, a
non-string kind, and a kind outside the vocabulary, then checks compatibility:
`commit_indeterminate` accepts only `commit_applied` or `commit_not_applied`,
and `cleanup_failed` accepts only `cleanup_disposed`. A refusal returns a
structured reason and leaves the artifact and the record untouched.

Covered by three probes: a cleanup resolution against an unknown commit, a
commit resolution against a failed cleanup, and an invented kind. Each asserts
the adapter saw nothing and the record kept its evidence.
