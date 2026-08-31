# P1: uncloneable indeterminate evidence loses the write record

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `d43ae10`

## Finding

`UnreconciledStore.record` clones evidence only after a commit has thrown.
For a directly executed staged `WRITE`, no approval or plan store preflights
the diff. If a change contains an uncloneable nested value, the application
write can land, `structuredClone` then throws inside the indeterminate catch,
and no reconciliation record is created.

This was reproduced against the built package with `after: () => 1`. The
commit incremented live state, `runtime.invoke` then rejected with a raw
`DataCloneError`, and `listUnreconciled()` was empty.

## Required correction

Detach and validate derived evidence before dispatch, at the staging boundary.
If it cannot become durable evidence, refuse before commit and release the
artifact. Recording an unknown outcome must itself be non-throwing after the
write may have landed.

## Regression requirement

Use uncloneable nested `before` and `after` values on both direct and approved
staged operations. No handler may run when evidence cannot be recorded, and no
post-dispatch recording failure may escape the structured result contract.

## Resolution

Evidence is detached at the staging boundary, before anything is dispatched.
`buildStageHandler` structurally clones and deep-freezes the adapter's diff
immediately after `diff` returns; a diff that cannot become durable evidence
releases the artifact and refuses with `PREVIEW_UNAVAILABLE`, while refusing
is still free. `UnreconciledStore.record` is now non-throwing as well, since
it runs after a write may have landed and losing the record there would lose
the only trace of it.

Covered by two probes with an uncloneable nested `after`, on the direct and
the approval paths. Both assert no dispatch, no live-state change, no open
artifact, and no record.
