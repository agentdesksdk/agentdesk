# P1: the merge drops row deletion and array removal

Status: **OPEN**

Reviewed worktree: `noble-orbit`, detached at `2bc6f6a`, with Agent 4's uncommitted staging changes

## Finding

`mergeBranch` iterates the human's rows and preserves a row when the agent's
branch no longer contains it. Agent deletion therefore never lands. Its
generic list rule also unions every array, so clearing an array preserves all
of its previous values.

Both failures affect shipping demo capabilities now:

- `merge_customers` derived a preview that removed the duplicate, returned
  success after approval, and left the duplicate customer present.
- `anonymize_customer` ran `target.notes = []`, returned success after
  approval, and retained the private note.

The comment that every array in `DemoState` is append-only is false for
`notes`, and the derived preview itself omits array removals.

## Required correction

Model merge policy per collection field. Row presence needs an explicit
three-way rule for unchanged, created, deleted, modified, and delete-versus-
modify conflict. Only fields declared append-only may use union semantics.
Array replacement or removal must land when the human side is unchanged and
must conflict when both sides changed.

## Regression requirement

Drive `merge_customers` and `anonymize_customer` through request, approval,
receipt, and live state. Assert the duplicate row and notes are actually gone,
and that the derived preview equals the landed change.
