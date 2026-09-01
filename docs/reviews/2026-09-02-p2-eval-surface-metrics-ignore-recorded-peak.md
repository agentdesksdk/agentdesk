# P2: the eval surface metrics read the idle snapshot, never the recorded peak

Status: **RESOLVED**

Reviewed `origin/main` at `87e6d6e` (PR #14). Tracked as issue #18.

## Finding

`probeTask` records `peakVisibleToolCount` and `peakSchemaBytes` on every
record, and no metric read either. `visibleToolCount` and
`registeredSchemaBytes` read the pre-task snapshot. The fairness rule that
surface figures are task-time peak on both arms was satisfied by accident:
peak equals the snapshot in all twelve reference records, so the published
numbers were correct, but an AgentDesk arm whose surface grew mid-run would
have been under-reported while the correct figure sat unused.

## Required correction

Read the peak fields.

## Regression requirement

A synthetic record whose peak exceeds its snapshot, asserting the metric
follows peak. A test built only from the reference records passes either way.

## Resolution

Both metrics read the peak fields. Covered by "surface metrics follow the
task-time peak" in `scripts/evals/test/metrics.test.mjs`, which fails against
the previous field names. The reference report recomputes unchanged.
