# P1: reset forgets open staged artifacts

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `5a6d828`

## Finding

`reset()` calls `proposals.discardAll()` and then unconditionally calls
`unreconciled.clear()`. This loses pre-existing indeterminate commits. It also
loses a cleanup failure created by that same `discardAll()`: if `release`
throws, the cleanup hook records the still-open artifact and the next line
immediately deletes its only runtime record.

This was reproduced against the built package after a commit wrote live state
and threw. Before reset there was one open artifact and one unreconciled
record. After reset the artifact was still open in the adapter and
`listUnreconciled()` was empty.

## Required correction

Reset must not erase an unresolved external condition. Either reconcile or
successfully dispose every staged artifact before clearing its record, retain
the records across reset, or refuse reset with a structured reason while
unreconciled work exists. A cleanup failure raised during reset must survive
the reset.

## Regression requirement

Cover both cases: an indeterminate commit that predates reset, and a pending
proposal whose `release` throws during reset. In both, the open artifact must
remain discoverable after reset until an explicit terminal recovery succeeds.

## Resolution

`reset()` no longer clears the unreconciled store. A reset clears the
runtime's own bookkeeping; it cannot clear an artifact still open in the
application, and deleting the record would lose the only thing that could
still find it. A disposal that fails during the `discardAll` inside reset
records itself and survives for the same reason, since nothing after it wipes
the store.

Covered by two probes: an indeterminate commit that predates the reset, and a
pending proposal whose `release` throws during it. Both assert the record
survives and the adapter still reports the artifact open.
