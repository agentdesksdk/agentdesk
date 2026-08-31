# P2: start does not validate the required reconciliation hook

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `d43ae10`

## Finding

`StagingAdapter.reconcile` is now required and is the only path that can close
an unknown artifact. The JavaScript boundary's start-time hook validation
still checks only `scope`, `fork`, `diff`, `commit`, and `release`.

This was reproduced against the built package by deleting `reconcile` from an
otherwise valid adapter. `runtime.start()` succeeded. The missing recovery
capability is discovered only after a write becomes indeterminate, where the
runtime catches the resulting `TypeError` and leaves the record open forever.

## Required correction

Include `reconcile` in the composition-time adapter validation. A runtime with
staged capabilities must refuse to start unless every required hook exists.

## Regression requirement

Construct the adapter through `unknown` as a JavaScript caller would, omit
`reconcile`, and assert `start()` refuses before any tool is registered.

## Resolution

`reconcile` joins `scope`, `fork`, `diff`, `commit`, and `release` in the
start-time adapter validation. A runtime with staged capabilities refuses to
start without it.

Covered by a probe that deletes `reconcile` through `unknown` as a JavaScript
caller would, and asserts `start()` rejects with no tool registered.
