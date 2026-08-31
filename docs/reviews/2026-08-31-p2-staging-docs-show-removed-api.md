# P2: staging documentation still shows the removed API

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `0123fbc`

## Finding

The implementation moved the adapter to `createAgentDeskRuntime`, but the
top-level README still says a capability declares its adapter and shows
`staging: { adapter: stagingAdapter, write: refundShipping }`. That shape is
now explicitly rejected. The architecture document also still calls the plan
boundary `stagingScope`, an option removed when `scope` moved onto the adapter.

This leaves the first adoption example teaching an API that cannot start, even
though later paragraphs describe the new runtime-level binding correctly.

## Required correction

Update the example to bind `staging` on `createAgentDeskRuntime` and declare
only `{ write }` on each capability. Replace the remaining `stagingScope`
terminology with `staging.scope`, and search all published documentation for
the removed capability-level adapter shape before merging.

## Regression requirement

Compile or execute the README's staged-capability example in the documentation
check so a removed public shape cannot remain the primary onboarding path.

## Resolution at `1f4a2b6`

The README example is now generated from
`packages/webmcp/examples/staged-capability.ts`, which `pnpm typecheck`
compiles, and `pnpm check:docs` fails when the README text and that file
disagree. Reverting the README to `staging: { adapter, write }` was checked
and does fail the run.

The example binds `staging` on `createAgentDeskRuntime` and declares
`staging: { operation }` on the capability. `stagingScope` is gone from
`docs/architecture.md`, replaced by `adapter.scope`.
