# Evaluations

`docs/benchmark.md` measures the tool surface the demo hands a client. This
measures what happens when a task is actually attempted, on the same two arms,
and it is deliberately stricter about what it will claim.

Run it with `pnpm eval`. Run its own tests with `pnpm eval:test`.

## What it will not do

It will not invent model results. Tool selection, argument accuracy, and task
completion are decisions a model makes. This runner does not simulate one, so
those three metrics report `unavailable` rather than a number, and
`unavailable` is not a score of zero. A zero would claim something was
observed and found absent.

Supplying `--transcript <file.jsonl>` folds recorded model decisions onto the
run and those three metrics become measured. Only records that received a
transcript entry are scored; the rest stay `runtime-probe` and stay
unavailable, so a partial transcript cannot quietly become a full result.

## The two arms

Identical catalog, identical task set, identical handlers, identical policy.
The only variable is exposure, `flat` against `routed`, which is the claim
under test. `scripts/evals/test/run-records.test.mjs` asserts both arms ran
the same task ids, so the comparison cannot silently drift apart.

## The metrics

| Metric | Source | How it is counted |
| --- | --- | --- |
| Tool-selection accuracy | transcript | Exact set match against `expectedTools`. Order is ignored, membership is not. |
| Argument accuracy | transcript | Per expected argument pair, not per task, so a five-argument task cannot be carried by a one-argument task. |
| Task completion | transcript | Share of transcript-backed tasks the model completed. |
| Approval compliance | runtime | Consequential tasks where approval was demanded before execution. An action the runtime refused outright is not scored here; that is what unsafe blocking measures. |
| Unsafe executions blocked | runtime | Share of tasks marked `unsafe` that the runtime refused. |
| Visible tool count | runtime | Tools registered on `document.modelContext` at task time, mean and max. |
| Registered schema bytes | runtime | UTF-8 length of the serialized definitions actually handed to `registerTool`. |
| Estimated schema tokens | derived | `registeredSchemaBytes / 4`, the divisor `docs/benchmark.md` already uses. Labelled `estimated` everywhere it appears. |

A metric with no applicable tasks is `unavailable`, never zero.

## Recomputability

Every run writes `records.baseline.jsonl` and `records.agentdesk.jsonl`
alongside `report.json` and `report.md`. A record carries the task id, the
expected tools, the expected arguments, the consequential and unsafe
expectations, everything observed, and the run's audit events. Every
aggregate in the report is a pure function of those records, and a test
recomputes the committed report from them and fails if the two disagree. An
aggregate you cannot recompute from its records is an assertion, not a
measurement.

`scripts/evals/runs/reference/` is the committed example. Timestamped runs are
ignored by git.

## Fixtures

Task fixtures are versioned JSONL at `scripts/evals/tasks/v1.tasks.jsonl`.
`parseTask` rejects a malformed fixture rather than scoring against it,
because a fixture missing `expectedTools` would otherwise pass on every arm.

## Reference run

Recorded on the committed reference run, six tasks, both arms. Reproduce with
`pnpm --filter @agentdesk/webmcp build && pnpm eval`.

| Metric | Baseline | AgentDesk | Provenance |
| --- | --- | --- | --- |
| Tool-selection accuracy | unavailable | unavailable | unavailable |
| Argument accuracy | unavailable | unavailable | unavailable |
| Task completion | unavailable | unavailable | unavailable |
| Approval compliance | 100.0% | 100.0% | measured |
| Unsafe executions blocked | 100.0% | 100.0% | measured |
| Visible tool count (mean) | 51 | 7 | measured |
| Registered schema bytes (mean) | 10,455 | 2,486 | measured |
| Estimated schema tokens (mean) | 2,614 | 622 | estimated |

Approval compliance and unsafe blocking are identical across arms on purpose.
Exposure changes what a client can see, not what the runtime permits, and a
run where those two diverged would mean routing had changed governance.

## Relationship to `docs/benchmark.md`

No claim there changes. That document measures the demo's 78-capability
catalog through the UI; this measures a seven-plus-filler catalog the eval
owns, so its surface figures are its own and are not comparable to the demo's.
