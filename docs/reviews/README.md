# Review tracker

Review target: AgentDesk SDK and Meridian Ops demo

Validated against commits `6a1745e`, `812e5b9`, and `2f1f332`.

Two of those three are pre-merge branch commits and are not reachable from
`main`, because their pull requests were squash-merged. They are recorded
here so the findings below stay resolvable after the branches are pruned.

| Cited | Reachable from `main` | Merged as |
| --- | --- | --- |
| `6a1745e` | yes | `6a1745e` |
| `812e5b9` | no | `1167867` (#2) |
| `2f1f332` | no | `81bc7af` (#5) |

Current gates on `2f1f332`: 326 tests passed, all three TypeScript projects typechecked, SDK and both applications built, assembled distribution passed, and the packed SDK imported and executed under plain Node.

| Severity | Status | Finding |
| --- | --- | --- |
| P1 | OPEN | [Execution actor changes while the handler is in flight](2026-08-29-p1-execution-actor-changes-mid-flight.md) |
| P1 | PARTIALLY FIXED | [Human review is attributed to the agent](2026-08-29-p1-human-review-attributed-to-agent.md) |
| P1 | OPEN | [Plan approval is attributed to the requesting agent](2026-08-29-p1-plan-approval-attributed-to-agent.md) |
| P1 | RESOLVED | [Presentation callback failure corrupts a completed write outcome](2026-08-29-p1-presentation-callback-corrupts-write-outcome.md) |
| P1 | OPEN | [Reset allows in-flight plans and rollbacks to repopulate audit state](2026-08-29-p1-reset-leaks-in-flight-terminal-events.md) |
| P1 | OPEN | [Single-action approval has no approver identity](2026-08-29-p1-single-action-approval-has-no-approver.md) |
| P1 | OPEN | [A rollback that commits and throws can run twice](2026-08-29-p1-throwing-rollback-can-run-twice.md) |
| P2 | OPEN | [Repeated live-region announcements are dropped](2026-08-29-p2-identical-live-announcements-are-dropped.md) |

Delete this directory only after every open item has either a validated fix or an explicit accepted-risk decision.
