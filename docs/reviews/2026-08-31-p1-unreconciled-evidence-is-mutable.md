# P1: unreconciled evidence is mutable through the public API

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `5a6d828`

## Finding

`UnreconciledStore.record` retains the caller's `changes` array and `list()`
only shallow-copies the containing record. A caller can mutate a change
returned by `listUnreconciled()` and thereby rewrite the runtime's stored
evidence. `get_action_status` reads that same store, so it reports the forged
value afterward.

This was reproduced against the built package by changing
`listUnreconciled()[0].changes[0].after` from `cancelled` to `forged`. A second
call to `listUnreconciled()` returned `forged`.

## Required correction

Detach and freeze the evidence at the store boundary, and return detached
copies or immutable values from reads. Because `before` and `after` accept
arbitrary structured values, protect nested data rather than only cloning the
outer array. If evidence cannot be cloned, refuse to record the staged result
before presenting it as durable evidence.

## Regression requirement

Attempt to mutate the array, a change object, and nested `before`/`after`
values returned from `listUnreconciled()`. None may affect a later list call or
`get_action_status`.

## Resolution

`UnreconciledStore.record` structurally clones the entry and deep-freezes it,
and `list`, `forAction`, and `attach` all return or store frozen clones, so
nested `before` and `after` values are protected rather than only the outer
array. `Unreconciled.changes` is `readonly Change[]`, which also refuses the
cast at compile time.

Covered by a probe that pushes to the array, replaces a change's `after`, and
mutates a nested field inside it, then asserts a later `listUnreconciled` and
`get_action_status` both still report the original value.
