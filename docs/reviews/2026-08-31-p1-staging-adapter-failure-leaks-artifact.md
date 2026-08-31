# P1: staging adapter failures leak the artifact

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `798c899`

## Finding

`buildStageHandler` does not release the staged artifact when `adapter.diff`
throws. The fork has already succeeded, but no proposal is returned to the
runtime, so the normal discard path cannot reach it.

The commit path has the same defect. It sets the proposal's `settled` flag
before calling `adapter.commit`. If commit throws before consuming the
artifact, the runtime calls `discard`, sees `settled`, and skips
`adapter.release`.

Both cases were reproduced against the built package. A diff failure returned
`PREVIEW_UNAVAILABLE` with one open artifact and zero releases. A commit failure
returned an execution error with the same open artifact and zero releases.
These branches remain visible as staged ghosts in adapters that track open
artifacts.

## Required correction

Once `fork` returns an artifact, `buildStageHandler` must release it on every
path that does not complete a successful commit. Wrap diff derivation and
thenable refusal so they release before propagating failure. If commit throws,
call release exactly once before marking the proposal terminal. Preserve the
original error if cleanup also fails, while reporting the cleanup failure for
diagnosis.

## Regression requirement

Add separate tests for a throwing `diff`, a non-array diff, a thenable staged
result, and a `commit` that throws before consuming its artifact. Each must
return the existing structured failure, leave zero live artifacts, and call
release exactly once. Make the release hook throw in one additional test so a
cleanup error cannot hide the original failure or cause a second release.

## Resolution at `7667d74`

`buildStageHandler` releases the artifact on every path that does not reach a
successful commit. `releaseAndRethrow` handles the thenable refusal, a
throwing `diff`, a `diff` that is not an array, and a throwing `commit`, and
it swallows a failing `release` so the original staging error is what
propagates. The proposal's `settled` flag is now set before `adapter.commit`
is called but the throw path releases explicitly, so a commit that fails
releases exactly once and the later `discard` is correctly a no-op.

Covered by `packages/webmcp/tests/staged-trust.test.ts`: a throwing diff, a
non-array diff, a suspended staged write, a throwing commit, and a release
that itself throws. Each asserts the existing structured failure, zero open
artifacts, and exactly one release. All five fail at `798c899`.

## Re-review at `0123fbc`

The ordinary failure paths now call `release` exactly once, but a throwing
`release` is swallowed completely. That is an attempted cleanup, not a
completed cleanup. The artifact can remain open and there is no audit event,
result field, retained proposal, or other recovery path saying cleanup failed.

This was reproduced against the built package with an adapter whose `diff`
throws and whose `release` also throws. The call returned only
`PREVIEW_UNAVAILABLE` for the diff failure while the adapter still reported one
open artifact. The existing cleanup-failure test counts calls to `release`; it
does not assert zero open artifacts, despite the resolution text claiming that
all five tests do.

Preserve the original staging failure, but also make the cleanup failure
observable and the artifact recoverable or explicitly indeterminate. A
successful return from `release` may establish disposal; merely invoking a
hook that throws cannot. Add a regression that asserts the artifact's actual
terminal state, not only the number of release attempts.

## Resolution at `fb76baf`

A `release` that throws is now reported rather than swallowed. It raises
`staged_cleanup_failed` in the audit and records an entry in
`listUnreconciled` naming the operation and the cleanup error, because
invoking a hook that throws disposes nothing and the artifact is still open in
the application. The original staging failure is still what the caller is
told.

The earlier record overstated its own coverage. The cleanup-failure test
counted release attempts and did not assert the artifact's terminal state,
while the resolution text claimed all five tests asserted zero live artifacts.
That was wrong, and the replacement asserts the adapter still reports one open
artifact and that a matching unreconciled record exists. A separate probe
asserts a successful release leaves zero open artifacts and nothing
unreconciled.
