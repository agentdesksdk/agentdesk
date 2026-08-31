# P1: the merge drops row deletion and array removal

Status: **RESOLVED**

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

## Resolution

`mergeBranch` decides row presence explicitly for every combination of base,
human, and agent, including agent deletion, human deletion, and the
delete-versus-modify collision, which is reported rather than resolved. Array
fields union only when neither side removed anything; any removal is a
replacement that lands when the other side left the field alone and conflicts
when both moved it. `deriveEntries` reports removals as well as additions, so
a preview can no longer omit an erasure.

Covered by `apps/demo/tests/staging.test.ts`, which drives `merge_customers`
and `anonymize_customer` through request, approval, and live state, and
asserts the derived preview equals the landed change.
