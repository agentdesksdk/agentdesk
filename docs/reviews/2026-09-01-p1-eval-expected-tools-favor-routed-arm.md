# P1: the shared expected tool set favors the routed arm

Status: **RESOLVED** in `df2669a`

Reviewed worktree: `cheery-obsidian`, commit `2f1f9e8` (PR #14)

## Finding

Every task has one `expectedTools` set shared by both arms, and five of the six
fixtures require `find_capabilities` before the terminal capability. That is
the correct routed protocol, but it is not the correct flat protocol. In the
baseline arm the terminal capability is already registered and visible, so a
model that calls it directly has made the shortest correct selection.

The exact-set metric scores those two correct arm-specific flows differently:

```text
baseline selected [refund_shipping]                  => 0/1
agentdesk selected [find_capabilities, refund_shipping] => 1/1
```

This makes the future model comparison structurally favor AgentDesk before a
model is run. The arms may share the task intent, catalog, handlers, and policy,
but they cannot share an expected interaction trace when exposure itself is
the variable under test.

Affected code: `scripts/evals/tasks/v1.tasks.jsonl:1-6`,
`scripts/evals/schema.mjs:65`, and `scripts/evals/metrics.mjs:41-48`.

## Required correction

Keep one task intent but define arm-specific acceptable selections, or score
terminal capability correctness separately from discovery overhead. A direct
terminal call must be correct in the flat arm; discovery followed by the
terminal call must be correct in the routed arm.

Do not solve this by removing `find_capabilities` from the one shared set,
because that would merely reverse the bias and penalize the routed protocol.

## Regression requirement

For the same refund task, supply a baseline transcript that calls only
`refund_shipping` and a routed transcript that calls `find_capabilities` then
`refund_shipping`. Both must receive full tool-selection credit. A transcript
that chooses the wrong terminal capability must still fail in either arm.
