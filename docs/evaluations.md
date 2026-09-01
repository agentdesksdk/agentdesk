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

Expected traces are per arm, because the correct trace differs by arm. Every
tool is already visible on the flat arm, so a correct agent there calls the
terminal tool directly and a discovery call would be waste. Requiring
`find_capabilities` of both arms scored correct flat-arm behaviour as a
failure and handed the routed arm a free point, which made the harness
flatter the thing it exists to test. Tool-selection accuracy is therefore not
comparable across arms; terminal-tool accuracy is, and that is what it is
for.

## The metrics

| Metric | Source | How it is counted |
| --- | --- | --- |
| Tool-selection accuracy | transcript | Exact set match against that arm's `expectedTools`. Order is ignored, membership is not. |
| Terminal-tool accuracy | transcript | Whether the right terminal action was chosen, over tasks that should act. The one figure comparable across arms. Refusal tasks are excluded, because a task whose correct outcome is refusing has no correct terminal action, and scoring them credited the arm that exposed an unsafe tool over the arm that refused to. |
| Transcript coverage | transcript | How much of the task set a transcript covered. Rendered on the report so a rate from part of the set cannot read as a rate over it. |
| Argument accuracy | transcript | Per expected argument pair, not per task, so a five-argument task cannot be carried by a one-argument task. |
| Task completion | transcript | Share of transcript-backed tasks the model completed. |
| Approval compliance | runtime | Consequential tasks where approval was demanded before execution. An action the runtime refused outright is not scored here; that is what unsafe blocking measures. |
| Unsafe executions blocked | runtime | Share of tasks marked `unsafe` the runtime refused *before dispatch*. An exception proves a handler did not return; it does not prove the write did not land, so a handler that committed and then threw is not a refusal. |
| Visible tool count | runtime | Tools registered on `document.modelContext` at task time, mean and max. |
| Registered schema bytes | runtime | UTF-8 length of the serialized definitions actually handed to `registerTool`. |
| Estimated schema tokens | derived | `registeredSchemaBytes / 4`, the divisor `docs/benchmark.md` already uses. Labelled `estimated` everywhere it appears. |

A metric with no applicable tasks is `unavailable`, never zero.

## Recomputability

Every run writes `records.baseline.jsonl` and `records.agentdesk.jsonl`
alongside `report.json` and `report.md`. A record carries the task id, the
expected tools, the expected arguments, the consequential and unsafe
expectations, everything observed, and the run's audit events. Every
aggregate in the report is a pure function of those records. A test rebuilds
`report.json` from the fixtures, the records, and the canonical arm table,
compares it deeply, then renders the Markdown and compares that too. Nothing
derivable is taken from the artifact under test, because a rebuild fed its
own metadata validated a task count of 999 and a label of "AgentDesk always
wins". Only `at` is carried across, since nothing can derive a timestamp, and
it is shape-checked instead. because comparing only each metric's value
let a corrupted provenance, a wrong denominator, and a stale document
survive. A reader believes the document, not the number behind it. An
aggregate you cannot recompute from its records is an assertion, not a
measurement.

`scripts/evals/runs/reference/` is the committed example. Timestamped runs are
ignored by git.

Recomputability across hosts has one more dependency. `visibleToolCount` and
`registeredSchemaBytes` follow which capabilities route, and routing breaks a
tied score by name. That tie-break is codepoint order, which is the same on
every host, so a tie at the cut resolves identically everywhere. In the
reference run no task ties at the cut in any case: every task scores fewer
capabilities than the budget, so nothing is truncated. Adding a capability
that matches a task, or tightening the budget, can create a tie at the cut,
and the codepoint tie-break is what keeps the numbers reproducible when it
does. Both surface metrics read the task-time peak of each record rather
than the pre-task snapshot, so an arm whose surface grows during execution
is charged for what the agent could actually see.

## Fixtures

Task fixtures are versioned JSONL at `scripts/evals/tasks/v2.tasks.jsonl`.
`parseTask` rejects a malformed fixture rather than scoring against it,
because a fixture missing `expectedTools` would otherwise pass on every arm.
`loadTasks` additionally refuses a task set containing a duplicate id, since
two tasks sharing an id match the same transcript entry and score one
observation twice, which reads as full coverage.

The loaders live in `scripts/evals/load.mjs`, apart from the CLI. A helper
worth testing must not perform an evaluation to be reached, and importing the
transcript loader from `run.mjs` used to run both arms and write a timestamped
directory. A test snapshots the run directory around a fresh child process that imports
`load.mjs`, compares the two sets, and asserts the child printed nothing, so
that regression announces itself. It measures what the import did rather than
what happened to be on disk, which means your earlier runs are preserved and
`pnpm eval` followed by `pnpm eval:test` both pass.
`parseTranscriptEntry` applies the same rule to a transcript entry, and
`loadTranscript` validates the whole file against the loaded task set before
any of it is used. Defaulting an absent field turned a malformed entry into a
measured failure, which is the same sin as inventing a model result. Building
the lookup from raw fields first was quieter and worse: an entry naming no
arm, or an unknown task, simply never matched and vanished, and a duplicate
replaced the first without a word. A dropped entry is indistinguishable from
a run that never had one, so all three are refused with the offending line
number.

## Reference run

Recorded on the committed reference run, six tasks, both arms. Reproduce with
`pnpm --filter @agentdesk/webmcp build && pnpm eval`.

| Metric | Baseline | AgentDesk | Provenance |
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

Approval compliance and unsafe blocking are identical across arms on purpose.
Exposure changes what a client can see, not what the runtime permits, and a
run where those two diverged would mean routing had changed governance.

## Relationship to `docs/benchmark.md`

No claim there changes. That document measures the demo's 78-capability
catalog through the UI; this measures a seven-plus-filler catalog the eval
owns, so its surface figures are its own and are not comparable to the demo's.
