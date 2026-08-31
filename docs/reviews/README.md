# Review tracker

Review target: AgentDesk SDK and Meridian Ops demo

Validated against commits `6a1745e`, `812e5b9`, `2f1f332`, `2bc6f6a`,
`d7a4911`, `0c4f2fa`, `798c899`, and `0123fbc`.

Seven of those eight are pre-merge branch commits and are not reachable from
`main`, because their pull requests were squash-merged or their branch is
still open. They are recorded here so the findings below stay resolvable
after the branches are pruned.

| Cited | Reachable from `main` | Merged as |
| --- | --- | --- |
| `6a1745e` | yes | `6a1745e` |
| `812e5b9` | no | `1167867` (#2) |
| `2f1f332` | no | `81bc7af` (#5) |
| `2bc6f6a` | no | unmerged on `fix/acting-identity` |
| `d7a4911` | no | unmerged on `fix/acting-identity` |
| `0c4f2fa` | no | unmerged on `fix/staged-proposals` (#11) |
| `798c899` | no | unmerged on `fix/staged-proposals` (#11) |
| `0123fbc` | no | unmerged on `fix/staged-proposals` (#11) |

Current gates on `bf079ca`: 368 tests passed across 241 SDK, 4 P0, and 123 demo, all three TypeScript projects typechecked, SDK and both applications built, the packed SDK imported and executed under plain Node, and the design doc check passed at 32 claims and 28 anchors.

The six acting-identity findings below are resolved on the unmerged
branch `fix/acting-identity`. Its first reproduction commit is `32b99db`,
four `2026-08-30` findings reproduce on `ef68151`, and the two
identity-parsing findings reproduce on `d7a4911` through
`packages/webmcp/tests/actor-parsing.test.ts`. Record the squash sha in each
document and in the table above once it lands. Gates on that branch: 343
tests passed, all three TypeScript projects typechecked, SDK and both
applications built, assembled distribution passed, the packed SDK imported
and executed under plain Node, and the design doc check passed.

| Severity | Status | Finding |
| --- | --- | --- |
| P1 | RESOLVED | [Execution actor changes while the handler is in flight](2026-08-29-p1-execution-actor-changes-mid-flight.md) |
| P1 | RESOLVED | [Human review is attributed to the agent](2026-08-29-p1-human-review-attributed-to-agent.md) |
| P1 | RESOLVED | [Plan approval is attributed to the requesting agent](2026-08-29-p1-plan-approval-attributed-to-agent.md) |
| P1 | RESOLVED | [Presentation callback failure corrupts a completed write outcome](2026-08-29-p1-presentation-callback-corrupts-write-outcome.md) |
| P1 | RESOLVED | [Reset allows in-flight plans and rollbacks to repopulate audit state](2026-08-29-p1-reset-leaks-in-flight-terminal-events.md) |
| P1 | RESOLVED | [Single-action approval has no approver identity](2026-08-29-p1-single-action-approval-has-no-approver.md) |
| P1 | RESOLVED | [A rollback that commits and throws can run twice](2026-08-29-p1-throwing-rollback-can-run-twice.md) |
| P2 | RESOLVED | [Repeated live-region announcements are dropped](2026-08-29-p2-identical-live-announcements-are-dropped.md) |
| P1 | RESOLVED | [A presentation listener can change the invocation actor](2026-08-30-p1-presentation-listener-can-change-invocation-actor.md) |
| P1 | RESOLVED | [A plan changes executor mid-commit](2026-08-30-p1-plan-changes-executor-mid-commit.md) |
| P1 | RESOLVED | [A caller-supplied human identity is not normalized once](2026-08-30-p1-human-identity-is-not-normalized-once.md) |
| P2 | RESOLVED | [Audit types do not encode the human-only events](2026-08-30-p2-audit-types-do-not-encode-human-events.md) |
| P1 | RESOLVED | [Human identity shape is not validated at the JavaScript boundary](2026-08-30-p1-human-identity-shape-is-not-validated.md) |
| P2 | RESOLVED | [Human-only record fields remain typed as generic actors](2026-08-30-p2-human-only-record-fields-remain-generic.md) |
| P1 | RESOLVED | [Stop strands an interrupted rollback in progress](2026-08-30-p1-stop-strands-rollback-in-progress.md) |
| P1 | RESOLVED | [Recordability preflight discards the input snapshot](2026-08-31-p1-recordability-preflight-discards-input-snapshot.md) |
| P1 | RESOLVED | [Approval rejects a valid actor without an optional name](2026-08-31-p1-approval-requires-optional-actor-name.md) |
| P2 | RESOLVED | [Reconciler fields remain typed as generic actors](2026-08-31-p2-reconciler-fields-remain-generic-actors.md) |

| P1 | RESOLVED | [An async dry run writes live state before approval](2026-08-31-p1-async-dry-run-writes-live-state-before-approval.md) |
| P1 | RESOLVED | [The merge drops row deletion and array removal](2026-08-31-p1-merge-drops-row-and-array-removals.md) |
| P1 | RESOLVED | [Staged proposals are not bound to approval lifecycle](2026-08-31-p1-staged-proposal-is-not-bound-to-approval-lifecycle.md) |
| P1 | RESOLVED | [Dependent plan previews use the wrong base](2026-08-31-p1-dependent-plan-previews-use-the-wrong-base.md) |
| P1 | RESOLVED | [Derived approval evidence is self-attested](2026-08-31-p1-derived-evidence-is-self-attested.md) |
| P1 | RESOLVED | [Staged idempotency replay leaks a proposal](2026-08-31-p1-staged-idempotency-replay-leaks-proposal.md) |
| P1 | RESOLVED | [Invalid plan rejection destroys approved staged work](2026-08-31-p1-invalid-plan-rejection-discards-proposal.md) |
| P1 | RESOLVED | [Revision drift leaves staged proposals alive](2026-08-31-p1-plan-drift-leaks-staged-proposal.md) |
| P1 | RESOLVED | [Staging adapter failures leak the artifact](2026-08-31-p1-staging-adapter-failure-leaks-artifact.md) |
| P1 | RESOLVED | [A staged commit can land and be recorded as failed](2026-08-31-p1-staged-commit-can-land-and-be-recorded-failed.md) |
| P2 | RESOLVED | [Staging documentation still shows the removed API](2026-08-31-p2-staging-docs-show-removed-api.md) |
| P1 | RESOLVED | [A plan collapses an indeterminate commit to failure](2026-08-31-p1-plan-collapses-indeterminate-commit-to-failure.md) |
| P1 | RESOLVED | [Reset forgets open staged artifacts](2026-08-31-p1-reset-forgets-open-staged-artifacts.md) |
| P1 | RESOLVED | [Reconcile drops the record without settling the artifact](2026-08-31-p1-reconcile-drops-record-without-settling-artifact.md) |
| P1 | RESOLVED | [Unreconciled evidence is mutable through the public API](2026-08-31-p1-unreconciled-evidence-is-mutable.md) |
| P2 | RESOLVED | [The staged reconciler event is typed as a generic actor](2026-08-31-p2-staged-reconciler-event-is-generic-actor.md) |
| P1 | RESOLVED | [A direct staged write can repeat an indeterminate commit](2026-08-31-p1-direct-staged-write-can-repeat-indeterminate-commit.md) |
| P1 | RESOLVED | [Uncloneable indeterminate evidence loses the write record](2026-08-31-p1-uncloneable-indeterminate-evidence-loses-write.md) |
| P1 | RESOLVED | [Reconciliation accepts a contradictory resolution](2026-08-31-p1-reconcile-accepts-contradictory-resolution.md) |
| P1 | RESOLVED | [The audit and UI call an indeterminate plan failed](2026-08-31-p1-indeterminate-plan-audit-says-failed.md) |
| P2 | RESOLVED | [Start does not validate the required reconciliation hook](2026-08-31-p2-start-does-not-validate-reconcile-hook.md) |

Delete this directory only after every open item has either a validated fix or an explicit accepted-risk decision.
