# P1: duplicate task ids count one transcript twice

Status: **RESOLVED** in `pending`

Reviewed worktree: `cheery-obsidian`, commit `253a3be` (PR #14)

## Finding

The shipped fixture has a test asserting unique task ids, but the runner's
`--tasks` boundary does not enforce that invariant. `loadTasks` parses each
line independently and accepts duplicate ids. The transcript lookup is keyed
only by arm and task id, so one transcript entry is then applied to every task
sharing that id.

Two different parsed tasks named `duplicate` plus one AgentDesk transcript
entry reproduce this result:

```text
accepted task ids: [duplicate, duplicate]
one transcript entry applied to records: 2
transcript coverage: 2 / 2, 100%
task completion: 2 / 2, 100%
```

The runner has doubled one observation and reported full coverage. Testing the
committed fixture for uniqueness does not protect custom task sets accepted by
the documented CLI path.

Affected code: `scripts/evals/run.mjs:20-36` and
`scripts/evals/run.mjs:100-116`.

## Required correction

Validate the task set as a collection at `loadTasks`: reject a duplicate id
with both the first and repeated line numbers before loading a transcript or
starting a runtime probe.

## Regression requirement

Pass a custom two-line task file whose prompts differ but whose ids match. The
CLI must refuse before creating the output directory. Keep the shipped-fixture
uniqueness check as a separate repository invariant.
