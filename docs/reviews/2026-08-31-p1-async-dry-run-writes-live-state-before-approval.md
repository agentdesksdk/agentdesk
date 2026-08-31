# P1: an async dry run writes live state before approval

Status: **OPEN**

Reviewed worktree: `noble-orbit`, detached at `2bc6f6a`, with Agent 4's uncommitted staging changes

## Finding

`stageSpec` accepts the SDK's general `CapabilitySpec`, whose `execute` may
return a promise. `stage()` closes the module-global branch in `finally` as
soon as that promise is returned. When the handler resumes after an `await`,
`mutate()` addresses live state instead of the fork.

A focused probe staged an async consequential handler that yielded once and
then changed order `10428`. Merely evaluating `previewChanges` changed the
live order from `processing` to `cancelled`, before any approval existed.

The current 78 demo handlers are synchronous, but the public types and the
automatic factory do not encode that constraint. The next async handler would
silently bypass the approval boundary.

## Required correction

Do not execute an arbitrary capability handler under a module-global store
swap. Either make staged execution operate on an explicit branch-owned store
that remains isolated across awaits, or define a genuinely synchronous staged
handler type and enforce it at both the TypeScript and JavaScript boundaries.
A post-call thenable check alone is insufficient because the async function
has already started.

## Regression requirement

Stage a handler that awaits once and then mutates. Assert live state remains
unchanged until an explicit commit, including while unrelated human writes run.
