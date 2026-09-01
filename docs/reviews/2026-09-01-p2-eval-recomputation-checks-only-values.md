# P2: the recomputation test checks only metric values

Status: **RESOLVED** in `df2669a`

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
