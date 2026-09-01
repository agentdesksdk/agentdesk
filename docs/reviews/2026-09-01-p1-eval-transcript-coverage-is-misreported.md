# P1: partial and malformed transcripts become measured results

Status: **RESOLVED** in `fix-pending`

Reviewed worktree: `cheery-obsidian`, commit `2f1f9e8` (PR #14)

## Finding

`loadTranscript` parses arbitrary JSON objects into a last-write-wins map, and
`applyTranscript` treats the presence of any matching object as proof that all
three model decisions were observed. Missing fields become invented negative
observations: `selectedTools` becomes `[]`, `arguments` becomes `{}`, and
`completed` becomes `false`, all under `decisionSource: "transcript"`.

Coverage is then hidden in the human-facing report. A two-task run with one
perfect transcript entry produces a metric object with denominator 1, but the
Markdown says only:

```text
Task set `tasks`, 2 tasks, identical across every arm.
| Tool-selection accuracy | 100.0% | measured |
```

It does not say that only one of two tasks was observed. That contradicts the
documentation's claim that a partial transcript cannot quietly become a full
result. Duplicate entries are also silently overwritten, and malformed
entries are neither rejected nor kept unavailable.

Affected code: `scripts/evals/run.mjs:36-46`,
`scripts/evals/arms.mjs:92-104`, and `scripts/evals/report.mjs:39-52`.

## Required correction

Add a versioned transcript parser. Require a valid arm and task id, a string
array for `selectedTools`, an object for `arguments`, and a boolean for
`completed`; reject duplicate arm/task pairs and unknown pairs. A missing
observation must remain unavailable rather than being synthesized as failure.

Render coverage beside every transcript-backed metric, at minimum as
`numerator / observed / total` or `score (n of total tasks)`, separately for
each arm. If the intended publication contract requires complete transcripts,
fail the run instead of permitting partial coverage.

## Regression requirement

Cover a missing field, a duplicate entry, an unknown arm/task pair, and a
one-of-six partial transcript. The malformed inputs must refuse before a
report is written, and the partial case must visibly disclose 1/6 coverage in
both JSON and Markdown.
