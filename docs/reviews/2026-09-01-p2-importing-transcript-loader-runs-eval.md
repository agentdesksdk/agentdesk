# P2: importing the transcript loader executes the evaluation CLI

Status: **RESOLVED** in `873f57f`

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
