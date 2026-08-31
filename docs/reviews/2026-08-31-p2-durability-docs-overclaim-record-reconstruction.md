# P2: durability docs overclaim record reconstruction

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `9bb0a2b`

## Finding

The accepted-risk decision is correct, but its explanation says unreconciled
records survive or are reconstructible when an application persists the audit
stream. The emitted events preserve only an incident stub: record id,
capability, detail, and time. They do not preserve the approved changes,
operation fingerprint, action or plan linkage, operation index, or artifact.
The runtime also exposes no hydration API that can repopulate
`UnreconciledStore` from persisted events.

After restart, a durable audit can therefore prove that an unknown outcome
occurred. It cannot reconstruct the public `Unreconciled` record, restore the
direct-retry guard, make `listUnreconciled()` return it, or let `reconcile`
find it. The accepted-risk file's title says records do not survive, while its
body and `docs/future-directions.md` say they do; the two claims conflict.

## Required correction

State that persisted audit reconstructs a durable warning or incident stub,
not the runtime record. Both the record and artifact are lost on restart; the
artifact is the harder loss because it prevents reconciliation. Closing the
record half also requires durable record storage plus a hydration/replay API,
in addition to an adapter artifact key.

## Regression requirement

Documentation only. Compare the fields on `execution_indeterminate` and
`staged_cleanup_failed` with `Unreconciled`, and do not claim reconstruction
for fields the audit stream does not contain or state the runtime cannot
hydrate.

## Resolution

All three locations now say a persisted audit stream proves an incident
occurred and nothing more, and enumerate what the events omit: `changes`,
`operationKey`, `actionId`, `planId`, `operationIndex`, and the artifact. They
also state that `UnreconciledStore` has no method accepting a rebuilt entry,
so reconstruction is not possible even with a complete payload.

The accepted-risk file is retitled to match its body, and both losses are
named with their separate consequences: losing the record empties
`listUnreconciled` and removes the repeat guard with `operationKey`, and
losing the artifact makes reconciliation impossible. Closing it is listed as
three requirements rather than one, adding durable record storage and a
hydration API alongside the adapter artifact key.
