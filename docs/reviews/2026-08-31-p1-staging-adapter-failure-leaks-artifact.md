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

## Resolution at `4a4dbf1`

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
