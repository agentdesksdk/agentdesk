# P1: staged proposals are not bound to approval lifecycle

Status: **OPEN**

Reviewed worktree: `noble-orbit`, detached at `2bc6f6a`, with Agent 4's uncommitted staging changes

## Finding

The proposal cache is keyed only by capability name plus serialized input.
It has no approval or plan identity and receives no rejection, failure, or
expiry lifecycle event. `execute` deletes an entry, and demo reset clears all
entries; every other terminal path leaves it behind.

After rejecting `cancel_order`, the pending action disappeared but
`stagedChangesFor("orders", "10428")` still returned the cancellation ghost.
The UI therefore continued to show a proposal the human had rejected.

The same key can also be shared by a direct approval and one or more plans
with identical input. One preview can overwrite another, and the first
execution can consume the only entry. The fallback then runs the handler live
without the branch that supplied its `derived` preview.

## Required correction

Bind the staged artifact to the runtime's action or planned-operation id, not
to business input. The runtime must own its lifecycle and dispose it on
reject, policy denial, unavailability, reset, expiry, failed commit, and
successful commit. Missing staged evidence must fail closed; it must never
fall back to direct execution while claiming derived approval evidence.

## Regression requirement

Cover rejection, policy denial, stopped/reset approval, two plans with the
same operation, and a direct approval sharing the same capability and input.
No proposal may overwrite another or remain visible after its owner resolves.
