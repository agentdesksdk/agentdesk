# AgentDesk evaluation run

Run `reference` at 2026-09-01T00:46:04.269Z.

Task set `scripts/evals/tasks/v2.tasks.jsonl`, 6 tasks, identical across every arm.

Every figure below is recomputable from the raw records in this run's
directory. `unavailable` means nothing observed the value; it is not a
score of zero.

| Metric | Baseline (flat exposure) | AgentDesk (routed exposure) | Provenance |
| --- | --- | --- | --- |
| Tool-selection accuracy (per-arm trace) | unavailable | unavailable | unavailable |
| Terminal-tool accuracy (arm-neutral) | unavailable | unavailable | unavailable |
| Argument accuracy | unavailable | unavailable | unavailable |
| Task completion | unavailable | unavailable | unavailable |
| Approval compliance | 100.0% | 100.0% | measured |
| Unsafe executions blocked | 100.0% | 100.0% | measured |
| Visible tool count (mean) | 51 | 7 | measured |
| Registered schema bytes (mean) | 10,455 | 2,486 | measured |
| Estimated schema tokens (mean) | 2,614 | 622 | estimated |

## Transcript coverage

Model-dependent figures above are computed only from tasks a
transcript covered. A rate computed from part of the task set is not
a rate over the task set.

- **Baseline (flat exposure)** — 0 of 6 tasks (0.0%).
- **AgentDesk (routed exposure)** — 0 of 6 tasks (0.0%).

## Unavailable

These were not measured. No value is reported for them, and no
value should be quoted from this run.

- **toolSelectionAccuracy** — no recorded model transcript; tool selection is a model decision and was not observed
- **terminalToolAccuracy** — no task in this run both expected an action and carried a recorded model decision
- **argumentAccuracy** — no recorded model transcript; arguments are a model decision and were not observed
- **taskCompletion** — no recorded model transcript; completion depends on what the model attempted

## Reading this

Tool selection, argument accuracy, and task completion are model
decisions. This runner does not simulate a model, so they are
`unavailable` unless a recorded transcript was supplied with
`--transcript`. Approval compliance, unsafe blocking, visible tool
count, and schema bytes are runtime properties and are measured
directly on both arms.

Estimated schema tokens are derived, not observed. The estimator is
`registeredSchemaBytes / 4`, the same divisor the shipped benchmark
documentation uses.
