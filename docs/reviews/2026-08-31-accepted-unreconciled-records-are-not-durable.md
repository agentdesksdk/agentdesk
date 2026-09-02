# Accepted risk: unreconciled records and artifacts do not survive a restart

Status: **RESOLVED** in wave 1 item 1.7 (`feat/wave1-durability`), against the
three requirements below.

Raised at commit `16e405d`, during the review that found no remaining
actionable defects. Corrected at the review that found the first version of
this file overclaimed what a persisted audit stream recovers.

## The limitation

`UnreconciledStore` is in memory. A staged commit that throws after it may
have written leaves two things behind, and neither survives a page or process
restart.

A persisted audit stream proves an incident happened and no more.
`execution_indeterminate` and `staged_cleanup_failed` carry the record id, the
capability, the detail, and the time. They do not carry the approved
`changes`, the `operationKey`, the `actionId`, the `planId`, the
`operationIndex`, or the artifact. `UnreconciledStore` also exposes no method
that accepts a rebuilt entry, so even a complete payload could not be put
back. What survives is an incident stub, not the runtime record.

The two losses have different consequences.

Losing the **record** empties `listUnreconciled`, so nothing surfaces the
unresolved work, and takes `operationKey` with it, so the guard that refuses a
repeat of the same call is gone. The same operation can be dispatched again,
which is the double-apply that guard exists to prevent.

Losing the **artifact** is the harder one. `reconcile` needs the object the
adapter produced, and it is held by identity. Without it there is no way to
tell the adapter what a human found, so the incident cannot be closed at all.

Together that inverts the guarantee this runtime spent several reviews
establishing. An unknown outcome is supposed to stay open until a person
closes it. Here it stops being visible, stops being guarded, and becomes
uncloseable.

## Why it is accepted for now

AgentDesk is an embedded, backend-free runtime, and Meridian Ops is a
single-page demo whose state is a seeded in-memory document. There is no
durable store to hydrate from, and building one for the demo would be
scaffolding for a persistence layer the demo does not have.

The exposure is bounded by the same property: a demo restart discards the
application state the artifact refers to as well, so nothing is left
half-written across the boundary.

## What closing it requires

Three things, not one.

1. Durable storage for the unreconciled records, carrying every field on
   `Unreconciled` rather than the audit stub.
2. A runtime hydration or replay API that can put those records back, so
   `listUnreconciled` and the repeat guard work after a restart.
3. Adapter artifacts addressable by a durable key rather than by object
   identity, so `fork` records enough to rebuild one and `reconcile` accepts
   the key instead of the object.

The first two are runtime work; the third is an adapter contract change plus
whatever store the adopting application already runs. Until all three exist,
the SDK should not be described as production-stable. The limitation is stated
on `UnreconciledStore` itself and in `docs/future-directions.md`, not only
here.

## Resolution

All three requirements are met by a `persistence` adapter on the runtime
options, described in `docs/architecture.md` under "An unknown outcome
survives a restart".

1. `PersistedRecord` carries every field on `Unreconciled`, the executing
   actor, the state digest, and the grant id, sealed with a digest at save
   and verified at load, so a record with tampered evidence is refused
   rather than trusted.
2. `rehydrate` runs at `start` and puts verified records back through
   `UnreconciledStore.hydrate` under their saved ids, so `listUnreconciled`
   surfaces them and `operationKey` guards the repeat; idempotency claims
   are reloaded so a repeat of a claimed key after reload is refused rather
   than re-executed.
3. The staging adapter's optional `identify` names an artifact that cannot
   be cloned with a durable key, stored as a reference, and the persistence
   adapter's `resolveArtifact` rebuilds it at `reconcile`; a resolver that
   cannot rebuild it leaves the record open and says so.

Covered by `packages/webmcp/tests/durability.test.ts`: a staged commit that
throws after writing survives a stop and a fresh start on the same adapter
byte for byte and frozen, refuses the same `operationKey`, reconciles exactly
once through the staging adapter audited with the human, and does not come
back; an uncloneable artifact is re-identified and rebuilt, or left open with
the reason; a tampered record is refused at load; a claimed idempotency key is
refused after reload; a runtime with no persistence is unchanged. Nine of the
ten fail against the runtime before the adapter existed.
