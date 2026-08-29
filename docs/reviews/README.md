# Review tracker

Review target: AgentDesk SDK and Meridian Ops demo

Validated against commits `6a1745e`, `812e5b9`, `2f1f332`, and `2bc6f6a`.

Three of those four are pre-merge branch commits and are not reachable from
`main`, because their pull requests were squash-merged or their branch is
still open. They are recorded here so the findings below stay resolvable
after the branches are pruned.

| Cited | Reachable from `main` | Merged as |
| --- | --- | --- |
| `6a1745e` | yes | `6a1745e` |
| `812e5b9` | no | `1167867` (#2) |
| `2f1f332` | no | `81bc7af` (#5) |
| `2bc6f6a` | no | unmerged on `fix/acting-identity` |

Current gates on `2f1f332`: 326 tests passed, all three TypeScript projects typechecked, SDK and both applications built, assembled distribution passed, and the packed SDK imported and executed under plain Node.

The seven acting-identity findings below are resolved on the unmerged
branch `fix/acting-identity`, whose reproduction commit is `32b99db` and
whose four `2026-08-30` findings reproduce on `ef68151`. Record the squash
sha in each document and in the table above once it lands. Gates on that
branch: 339 tests passed, all three TypeScript projects typechecked, SDK and
both applications built, assembled distribution passed, the packed SDK
imported and executed under plain Node, and the design doc check passed.

| Severity | Status | Finding |
| --- | --- | --- |
| P1 | RESOLVED | [Execution actor changes while the handler is in flight](2026-08-29-p1-execution-actor-changes-mid-flight.md) |
| P1 | RESOLVED | [Human review is attributed to the agent](2026-08-29-p1-human-review-attributed-to-agent.md) |
| P1 | RESOLVED | [Plan approval is attributed to the requesting agent](2026-08-29-p1-plan-approval-attributed-to-agent.md) |
| P1 | RESOLVED | [Presentation callback failure corrupts a completed write outcome](2026-08-29-p1-presentation-callback-corrupts-write-outcome.md) |
| P1 | OPEN | [Reset allows in-flight plans and rollbacks to repopulate audit state](2026-08-29-p1-reset-leaks-in-flight-terminal-events.md) |
| P1 | OPEN | [Single-action approval has no approver identity](2026-08-29-p1-single-action-approval-has-no-approver.md) |
| P1 | OPEN | [A rollback that commits and throws can run twice](2026-08-29-p1-throwing-rollback-can-run-twice.md) |
| P2 | OPEN | [Repeated live-region announcements are dropped](2026-08-29-p2-identical-live-announcements-are-dropped.md) |
| P1 | RESOLVED | [A presentation listener can change the invocation actor](2026-08-30-p1-presentation-listener-can-change-invocation-actor.md) |
| P1 | RESOLVED | [A plan changes executor mid-commit](2026-08-30-p1-plan-changes-executor-mid-commit.md) |
| P1 | RESOLVED | [A caller-supplied human identity is not normalized once](2026-08-30-p1-human-identity-is-not-normalized-once.md) |
| P2 | RESOLVED | [Audit types do not encode the human-only events](2026-08-30-p2-audit-types-do-not-encode-human-events.md) |

Delete this directory only after every open item has either a validated fix or an explicit accepted-risk decision.
