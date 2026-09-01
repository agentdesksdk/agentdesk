# P2: the recomputation test checks only metric values

Status: **RESOLVED** in `aca9813`

Reviewed worktree: `cheery-obsidian`, commit `2f1f9e8` (PR #14)

## Finding

The test named `the published report is recomputable from the raw records`
compares only `report...metrics[name].value` with the recomputed value. It does
not check numerator, denominator, provenance, reason, min, max, mean, or the
estimator formula. The Markdown artifact is not regenerated and compared at
all.

Consequently, a committed report can retain the same displayed value while
claiming the wrong provenance or population and the test still passes. For
example, changing a 1/1 measured metric to 6/6, or changing `estimated` to
`measured`, survives the current check. Those fields are central to this
runner's promise not to invent results.

Affected code: `scripts/evals/test/run-records.test.mjs:52-61`.

## Required correction

Deep-compare each complete recomputed metric object with the stored metric.
Then rebuild the full report from the raw records and stable run metadata and
compare the complete JSON. Render Markdown from that rebuilt report and compare
it byte-for-byte with the committed `report.md`.

## Regression requirement

Prove the guard is load-bearing by changing only a denominator, only a
provenance value, and only the Markdown. Each mutation must fail the reference
artifact check even when the metric's numeric `value` is unchanged.

## Follow-up verification at `99d4139`

Metric objects and Markdown are now checked completely, but the test does not
recompute the whole report as claimed. It feeds `buildReport` the report's own
`runId`, timestamp, task path, task count, arm labels, and exposure values.
Those fields therefore validate themselves.

Changing the committed task count to 999 and the AgentDesk label to
`AgentDesk always wins`, then rebuilding with the test's current inputs,
still produces a deep-equal report and renders both corrupt values into
Markdown. The metrics remain honest while the purportedly checked artifact is
not.

Derive task count from the parsed fixture or record set, arm labels and
exposure from `ARMS`, and run id from a consistency check across every record.
Either make the timestamp explicit non-recomputable metadata or store the
source needed to validate it. Add mutations for task count, arm label,
exposure, and run id alongside the existing metric and Markdown guards.
