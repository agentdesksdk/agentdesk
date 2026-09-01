# Future directions

Nothing here is implemented. It is recorded so the design intent is legible
after the hackathon. Meridian Ops is the complete proof; this is the market
the same runtime addresses next.

## Positioning

AgentDesk is a control and governance layer that an application adopts, not
a wrapper that takes over someone else's application. That distinction sets
who the customer is: the team that owns the app, embedding the runtime the
same way Meridian Ops does.

Operations consoles are the first fit because their capability surface is
wide and their consequential actions are financial. The same shape applies
to slide editors, design tools, IDEs, and admin platforms: large internal
capability catalogs, a small task-relevant working set, and a handful of
actions a human should personally authorize.

### Beyond operations consoles

The same runtime fits any application with a wide capability surface and a
few actions a human should personally authorize: slide editors, design
tools, IDEs, admin platforms. Structured operations beat synthesized input
there for the same reason they do here, and more so, because GUI editing
depends on pixel geometry and continuous pointer state that a
screenshot-action loop cannot observe. AgentDesk is a layer an application
adopts, not a wrapper over someone else's app. The rest of this document
covers the catalog shape, batched edit sessions, and the integration
constraint. None of it is implemented; Meridian Ops is the proof.

## Creative and spatial applications

A deck editor is the clearest next case. Structured operations beat
synthesized input for the same reason they do in an ops console, only more
so, because GUI editing depends on pixel geometry, snapping behavior, and
continuous pointer state that a screenshot-action-screenshot loop does not
observe. Aligning two objects is one call against object ids:

```ts
align_objects({ slide_id: "slide-7", object_ids: ["title", "chart"], alignment: "left" });
```

That is repeatable, undoable, and independent of screen resolution, where
the equivalent drag is none of those things.

A plausible catalog splits along the existing risk classes. Reads such as
`get_deck_structure`, `get_slide_objects`, `get_theme`, and `render_slide`.
Writes such as `set_text`, `set_fill_color`, `move_object`,
`resize_object`, `align_objects`, `distribute_objects`, `replace_image`,
and `reorder_slides`. Consequential actions such as `delete_slide`,
`replace_entire_theme`, `publish_presentation`, and `change_sharing`, which
would route through the same approval state machine used for
`refund_shipping` today.

### Presentation in a spatial application

Guided execution generalizes, with one correction. In a canvas application
the informative thing to animate is the **object**, not a pointer. Showing
a title snap from its old position to the left guide tells the human what
changed; showing a synthetic cursor travel toward it tells them about an
input device the agent never used. The current `reveal` hint is already an
opaque string the application resolves, so a canvas app can map it to an
object id instead of a DOM anchor without an SDK change.

### Edit sessions: batched approval

The one genuinely SDK-level extension here is a transaction boundary.
Today approval is per-action, which is right when a single call moves
money. A visual edit is different: fifteen small operations compose one
intent, and reviewing them individually is worse than reviewing the result.

```ts
const session = await agentdesk.beginEditSession();
await session.preview([moveObject(...), setFillColor(...), resizeObject(...)]);
await session.commit(); // or session.rollback()
```

This is a natural widening of the existing `PENDING → EXECUTING →
APPROVED_EXECUTED` machine to a set of operations with one authorization
point, and it needs the same execution-time re-check on commit that single
approvals already perform. It is worth designing carefully rather than
quickly: rollback semantics against an application that may have changed
underneath the preview is the hard part, and the current runtime
deliberately has no undo model.

## The integration constraint

AgentDesk cannot simply attach to `slides.google.com`. WebMCP is something
a site adopts; a site that has not adopted it offers no place to stand.
That is a property of the standard, not a gap in this runtime. The
realistic paths, best first:

1. **The vendor adopts WebMCP.** Then AgentDesk is a library the vendor
   embeds, exactly as the demo does.
2. **An add-on or sidebar** writing through the application's own API
   (for Slides, the Slides API). Supported extension point, stable
   contract.
3. **A companion application** that owns the document and drives the
   vendor API, or an AgentDesk-native editor that exports to the vendor
   format.
4. **A browser extension injecting the runtime.** Brittle against markup
   changes, and it inherits security and maintenance problems that a
   governance layer should not have. Not recommended.

Options 2 and 3 are the credible products.

## Before this is production-stable

One limitation is known and accepted for the hackathon, recorded in
`docs/reviews/2026-08-31-accepted-unreconciled-records-are-not-durable.md`.

A staged commit that throws after it may have written leaves an unreconciled
record and a retained adapter artifact. Neither survives a restart. A
persisted audit stream proves an incident occurred and no more:
`execution_indeterminate` and `staged_cleanup_failed` carry the record id, the
capability, the detail, and the time, but not the approved `changes`, the
`operationKey`, the action or plan linkage, the operation index, or the
artifact. `UnreconciledStore` also has no method that accepts a rebuilt entry.

The two losses hurt differently. Losing the record empties
`listUnreconciled` and takes `operationKey` with it, so the guard that refuses
a repeat is gone and the same call can be dispatched a second time. Losing the
artifact is worse, because `reconcile` has nothing to hand the adapter and the
incident cannot be closed at all.

Closing this needs three things. Durable storage for the records. A hydration
or replay API that can put them back into the runtime. And adapter artifacts
addressable by a durable key, so `fork` records enough to rebuild one and
`reconcile` accepts the key rather than the object. All three are application
concerns that an embedded runtime with no backend cannot supply, which is why
none of them is in the demo.
