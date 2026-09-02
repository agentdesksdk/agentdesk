# AgentDesk evaluation run

Run `reference` at 2026-09-02T03:08:30.765Z.

Task set `scripts/evals/tasks/v2.tasks.jsonl`, 6 tasks, identical across every cell.

Two axes. Exposure, `flat` against `routed`, is what the agent can see
before it acts. Result shape, `bare` against `structured`, is what it is
handed after. Every cell ran the same catalog, the same tasks, the same
handlers, and the same policy.

Every figure below is recomputable from the raw records in this run's
directory. `unavailable` means nothing observed the value; it is not a
score of zero.

| Metric | Baseline (flat, bare) | Baseline (flat, structured) | AgentDesk (routed, bare) | AgentDesk (routed, structured) | Provenance |
| --- | --- | --- | --- | --- | --- |
| Tool-selection accuracy (per-arm trace) | unavailable | unavailable | unavailable | unavailable | unavailable |
| Terminal-tool accuracy (arm-neutral) | unavailable | unavailable | unavailable | unavailable | unavailable |
| Argument accuracy | unavailable | unavailable | unavailable | unavailable | unavailable |
| Task completion | unavailable | unavailable | unavailable | unavailable | unavailable |
| Approval compliance | 100.0% | 100.0% | 100.0% | 100.0% | measured |
| Unsafe executions blocked | 100.0% | 100.0% | 100.0% | 100.0% | measured |
| Evidence coverage (consequential completions with a link) | 0.0% | 100.0% | 0.0% | 100.0% | measured |
| Visible tool count (mean) | 51 | 51 | 7 | 7 | measured |
| Registered schema bytes (mean) | 10,455 | 10,455 | 2,486 | 2,486 | measured |
| Estimated schema tokens (mean) | 2,614 | 2,614 | 622 | 622 | estimated |
| Result bytes (mean) | 67 | 464 | 67 | 464 | measured |
| Estimated result tokens (mean) | 17 | 116 | 17 | 116 | estimated |

## Transcript coverage

Model-dependent figures above are computed only from tasks a
transcript covered. A rate computed from part of the task set is not
a rate over the task set.

- **Baseline (flat, bare)** — 0 of 6 tasks (0.0%).
- **Baseline (flat, structured)** — 0 of 6 tasks (0.0%).
- **AgentDesk (routed, bare)** — 0 of 6 tasks (0.0%).
- **AgentDesk (routed, structured)** — 0 of 6 tasks (0.0%).

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
`--transcript`, and a transcript scores only the cell whose arm and
shape it names. Approval compliance, unsafe blocking, evidence
coverage, visible tool count, schema bytes, and result bytes are
runtime properties and are measured directly in every cell.

A `bare` cell hands the agent the terminal result stripped to what a
plain handler returns: the value, or the message, and an approval id.
A `structured` cell hands it what the runtime emits: the receipt, the
changes, what is now possible, what stays blocked, a repair, and the
evidence. Evidence coverage on a bare cell is zero by construction and
is reported as measured, because the agent was handed nothing. Result
bytes are what the difference costs.

Estimated tokens are derived, not observed. The estimators are
`registeredSchemaBytes / 4` and `resultBytes / 4`, the same divisor the
shipped benchmark documentation uses.
