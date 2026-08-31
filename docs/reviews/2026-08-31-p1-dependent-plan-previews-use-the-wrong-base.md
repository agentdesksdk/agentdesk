# P1: dependent plan previews use the wrong base

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, detached at `2bc6f6a`, with Agent 4's uncommitted staging changes

## Finding

`prepare()` evaluates each operation's `previewChanges` independently against
live state. The staging layer supports nested composition, but the runtime
does not open one branch around preparation. Operation two therefore cannot
see operation one's proposed writes.

At commit time the operations run sequentially, so the plan the human saw is
not necessarily the plan that executes. Agent 4 called this gap out in the
work report; it remains untested and unfixed.

## Required correction

Give plan preparation one branch or proposal transaction. Each operation must
derive against the predecessor's staged head, and commit must consume the same
ordered artifacts. A conflict or missing artifact must fail the whole plan
before a later operation lands.

## Regression requirement

Prepare a two-operation plan where the second operation reads a value written
by the first. Assert its preview reflects that staged predecessor and the
combined preview exactly matches the final committed diff.

## Resolution

`prepare()` stages every operation inside one `stagingScope`, so each derives
against its predecessor's staged head. `commitPlan` consumes the same ordered
artifacts by index and checks that every staged operation still has one
before the first operation runs, so a plan missing an artifact fails whole
rather than landing part of itself. A plan containing a staged capability
without a configured `stagingScope` is refused at preparation.

Every write in the demo stages now, including WRITE-risk transitions, because
an unstaged operation contributed nothing to the combined preview while still
changing state at commit.

Covered by the plan probes in `apps/demo/tests/staging.test.ts` and the
missing-artifact probe in `packages/webmcp/tests/staged-proposals.test.ts`.
