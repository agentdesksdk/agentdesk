# P2: importing the transcript loader executes the evaluation CLI

Status: **RESOLVED** in `pending`

Reviewed worktree: `cheery-obsidian`, commit `253a3be` (PR #14)

## Finding

`boundary-integrity.test.mjs` imports `loadTranscript` from `run.mjs`, but
`run.mjs` calls `main()` unconditionally at module scope. Importing the helper
therefore starts a complete two-arm evaluation, prints a report, and writes a
new timestamped run directory as a side effect of loading the test module.

The worktree already contains multiple ignored `eval-*` directories created
during the fix's repeated test runs. A focused boundary test now depends on a
built SDK and writable repository even when it only wants to validate a JSONL
file. Importing a library function must not execute its CLI.

Affected code: `scripts/evals/test/boundary-integrity.test.mjs:8-10` and
`scripts/evals/run.mjs:141-144`.

## Required correction

Move task and transcript loading into an import-safe module, or guard CLI
execution with a direct-entry check so `main()` runs only when `run.mjs` is the
program entry point. Tests should place temporary files under an OS temporary
directory rather than the source tree.

## Regression requirement

Import `loadTranscript` in a fresh process and assert that it emits no stdout,
creates no run directory, and does not require `packages/webmcp/dist`. Then run
the CLI directly and prove it still produces the expected artifacts.

## Follow-up verification at `78651be`

Moving the loaders to `load.mjs` fixes the source side effect, but the new
regression test asserts that the global runs directory contains no `eval-*`
entry at all. That makes legitimate historical output indistinguishable from
an import side effect.

This was reproduced by placing one controlled entry named
`eval-legitimate-prior-run` in `scripts/evals/runs` before running the focused
loader suite. Three tests passed and `importing the loaders runs no evaluation`
failed, blaming the prior output on the current import. The marker was removed
after the probe.

The documented commands permit `pnpm eval` followed by `pnpm eval:test`, so
the suite must not require users to delete valid ignored runs first. Snapshot
the directory before importing in a fresh child process and compare it after,
or redirect the CLI's run root to a temporary directory. The regression must
also check stdout and independence from `packages/webmcp/dist`, as originally
required, instead of using global emptiness as a proxy.


## Correction to the first fix

Splitting the loaders was right; the test that guarded it was not. Asserting
that `scripts/evals/runs` holds no `eval-*` entry treated every artifact on
disk as evidence that the current import created it, so a legitimate earlier
`pnpm eval` failed the suite and the documented `pnpm eval` then
`pnpm eval:test` workflow could not both pass. It also proved nothing about
the import, only about what happened to be on disk when it looked.

The guard now snapshots the run directory around a fresh child process that
imports `load.mjs`, compares the two sets, and separately asserts the child
printed nothing. A pre-existing run is preserved and ignored. Appending a
`console.log` to `load.mjs` fails it with "importing a loader printed to
stdout, so it executed the CLI", so the guard still catches what it was
written for.
