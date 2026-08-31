# Accepted risk: unreconciled records do not survive a restart

Status: **ACCEPTED**

Raised at commit `16e405d`, during the review that found no remaining
actionable defects.

## The limitation

`UnreconciledStore` is in memory, like the rest of the runtime's state. Two
things are lost on a page or process restart, and they are worth separating.

The **records** are reconstructible. `execution_indeterminate` and
`staged_cleanup_failed` both carry the record id, the capability, and the
detail, so an application that persists `subscribeAudit` can rebuild the list
of what was left unresolved.

The **artifact** is not. It is a live object the adapter produced, held by
object identity, and `reconcile` needs it to settle anything. After a restart
a human can therefore still learn that a write may have landed, and can no
longer tell the adapter what they found.

That inverts the guarantee this runtime spent five reviews establishing. An
unknown outcome is supposed to stay open until a person closes it; here it
stays open and becomes uncloseable.

## Why it is accepted for now

AgentDesk is an embedded, backend-free runtime, and Meridian Ops is a
single-page demo whose state is a seeded in-memory document. There is no
durable store to rehydrate an artifact from, and inventing one for the demo
would be scaffolding for a persistence layer the demo does not have.

The exposure is bounded by the same property: a demo restart discards the
application state the artifact refers to as well, so nothing is left
half-written across the boundary.

## What closing it requires

An adapter whose artifacts are addressable by a durable key rather than by
object identity, so `fork` can record enough to rebuild one and `reconcile`
can accept the key instead of the object. That is an adapter contract change
plus an application-side store, and it belongs with whatever persistence the
adopting application already has.

Until that exists, the SDK should not be described as production-stable. It is
named as a limitation in `docs/future-directions.md` and in the
`UnreconciledStore` doc comment rather than only here.
