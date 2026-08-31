# P1: a direct staged write can repeat an indeterminate commit

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `d43ae10`

## Finding

The indeterminate model is surfaced for approvals and plans, but not for a
staged capability that policy allows to execute directly. `runCapability`
returns the generic error from `executeNow`, calls the already-settled
proposal's no-op `discard`, and provides neither the reconciliation record id
nor the explicit do-not-retry contract used by the other two entry points.

This is reachable by default: `WRITE` capabilities are allowed without human
approval. It was reproduced against the built package with an increment
operation whose commit updates live state and then throws `ack lost`. Calling
the tool twice advanced live state from 0 to 2 and created two unreconciled
records. Both calls returned only the exception sentence.

## Required correction

Use the same explicit indeterminate result envelope for every execution path.
It must include the record id and a do-not-retry instruction. Prevent a second
unkeyed invocation while an equivalent staged outcome remains unresolved, or
define an equally strong operation identity that makes the retry safe.

## Regression requirement

Invoke a staged `WRITE` whose commit mutates and throws, then invoke it again
without an idempotency key. The second call must not dispatch the operation,
and the first result must expose the record and recovery instruction.

## Resolution

The direct path returns the same envelope as the other two. A commit that
throws produces `EXECUTION_INDETERMINATE` carrying the record id, the detail,
the approved changes, and an explicit do-not-retry instruction, instead of the
bare exception sentence.

It is also guarded. An unresolved `commit_indeterminate` record is keyed by
capability plus input fingerprint, and an invocation matching an open key is
refused with that record rather than dispatched. The operation becomes
available again once a human reconciles it, which is the only thing that can
establish what happened.

Covered by three probes: the envelope, a repeat that leaves live state moved
once for two calls, and the same call succeeding after reconciliation.
