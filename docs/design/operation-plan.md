# Operation plans for capabilities nobody authored

Status: design only. Nothing here is implemented.

The plan machinery already shipped. Versioned plans, expected revisions,
preview, commit-exactly-once, readback verification, receipt history, and
rollback are in `packages/webmcp` and specified in `docs/architecture.md`
under "Plans, verification, and provenance". Read that first. This
document does not restate it and deliberately does not re-specify types
that exist.

What has not been designed is what happens to that machinery when
AgentDesk did not write the capability.

Every strong guarantee in the shipped model is delegated to a function
the application author supplied. `previewChanges` produces the diff a
human approves. `verify` reads state back after the write. `rollback`
undoes it. A capability generated from OpenAPI has none of the three, and
a capability inferred from a form has less than that. Handing those
capabilities to the plan store unchanged produces plans that look
governed and are not, which is worse than plans that admit what they
cannot do.

So the design question is not "how do plans work". It is which
guarantees survive contact with a capability whose semantics were
inferred, and how the ones that do not survive are made visible instead
of assumed.

## What each guarantee needs, and where it breaks

| Guarantee | Needs | Authored | Generated | Inferred |
| --- | --- | --- | --- | --- |
| Versioned plan | Nothing from the capability | Yes | Yes | Yes |
| Expected revision | A revision the app exposes | Yes | Sometimes | No |
| Preview | `previewChanges` | Yes | No | No |
| Commit exactly once | Idempotency key | Yes | Yes | No |
| Readback verification | `verify` | Yes | Sometimes | No |
| Receipt history | Nothing from the capability | Yes | Yes | Yes |
| Rollback | `rollback` and `verify` | Yes | Rarely | No |

The two columns that carry the whole design are Generated and Inferred.
Three rows are unconditionally fine, so plan identity, history, and audit
work everywhere and need no new design. The rest degrade, and the rule is
that a degraded guarantee is named in the plan rather than quietly
skipped.

```ts
type PlanAssurance = {
  preview: "diff" | "request" | "summary";
  revision: "checked" | "unavailable";
  verification: "readback" | "response" | "none";
  reversal: "rollback" | "compensating" | "none";
};
```

`PlanAssurance` is per operation and is computed at compile time, not at
approval time, so the answer is the same every run and a reviewer can see
it in `agentdesk inspect` before anything executes.

## Preview degrades to the request

A generated capability cannot diff application state, because it does not
know what the endpoint touches. It does know exactly what it is about to
send, which is the `RequestPlan` from `adapter-contract.md`.

That is a real preview and a weaker one. A human approving
`POST /orders/42/refund {"amount": 5000}` is approving a specific
request, not a specific outcome, and the approval UI says so in those
terms rather than rendering it as a change list. Presenting a request as
though it were a diff would be the dishonest version.

An inferred form capability drops one further, to `summary`. It knows the
form and the values, not the endpoint. The runtime already requires
`approvalEvidence: "summary"` to be a deliberate opt-in for consequential
capabilities, so the compiler sets it explicitly for these rather than
letting a default carry it. That is the same rule
`compileManifestEntry` enforces in `auto-sdk.md`.

## Expected revision is opt-in, and its absence is recorded

`expectedRevision` on `OperationPlan` is how the shipped model detects
that state moved between planning and commit. It works because the
application told AgentDesk what revision it was looking at.

A generated adapter can supply one when the API exposes it, typically an
`ETag` on the resource the plan reads. When it can, drift detection works
exactly as `docs/architecture.md` specifies and nothing here changes.

When it cannot, the plan records `revision: "unavailable"` rather than
omitting the field. The distinction is the point. A plan with no
`expectedRevision` because the API has no revision concept and a plan
with no `expectedRevision` because someone forgot are the same shape in
the store today, and they are very different facts. A plan that carries
`unavailable` cannot silently become a plan that was checked.

An inferred capability never has one. A form submission has no revision,
and inventing a hash over the visible DOM would be a revision of the
rendering rather than of the state.

## Verification degrades to the response

Readback verification re-reads state after the write and compares it to
what was expected. It needs a read path, and for a generated capability
that means a second operation the adapter also discovered.

Where the manifest contains a read whose path covers the write's
resource, the compiler can pair them and readback verification works. A
`POST /orders/:id/refund` next to a `GET /orders/:id` is the ordinary
case. The pairing is proposed by the compiler and confirmed by a human in
config, never assumed, because a wrong pairing produces a verification
that passes while checking the wrong thing, and a false pass is worse
than no check.

```ts
overrides: {
  refund_order: { verifyWith: "get_order" },
}
```

Without a pair, verification is `response`, meaning the operation
succeeded according to what the API returned and nothing independent
confirmed it. That maps onto the existing `VerificationResult` as an
explicit unverified outcome rather than as a pass.

For an inferred form capability, verification is `none`, and the
completion accounting in `docs/design/browser-extension.md` is what
stands in its place. Knowing that a human actually submitted the form,
and with which values, is not verification of the resulting state. It is
evidence about the action, and the plan labels it as such.

## Reversal is usually not rollback

`rollback` in the shipped model calls a function the author wrote to undo
a change. Almost nothing generated can offer that.

Since `1167867` it takes two functions, not one. Undo re-runs the
capability's own `verify` against the receipt's recorded input and
changes, and refuses on anything other than `VERIFIED`, so it cannot
overwrite state that legitimately moved after the receipt. A capability
declaring no verifier gets no such protection.

That lands hardest here. A generated capability rarely has `rollback` and
usually has no `verify` either, so the one case where the compiler could
offer an undo is also the case where the undo is unguarded. The compiler
therefore does not synthesize a reversal from a `rollback` alone. A
`compensateWith` override requires a `verifyWith` pairing alongside it,
and without both the entry stays `reversal: "none"`. Refusing to offer
undo is better than offering one that can silently destroy a newer value.

Where the source specification contains an inverse operation, the
compiler can propose a compensating action and a human confirms it in
config, the same shape as `verifyWith`. A compensating action is not a
rollback and the plan does not call it one. It is a second forward
operation that happens to undo the first, it is itself consequential, and
it can fail on its own.

```ts
overrides: {
  refund_order: { compensateWith: "reverse_refund" },
}
```

Where there is no inverse, `reversal: "none"`. The plan says so before it
runs, which is the only moment the information is useful. A human
approving an irreversible consequential action should know it is
irreversible while deciding, not discover it while looking for the undo
button.

An inferred form capability is always `none`. The extension submitted a
form on a site it does not own, and there is no general way to un-submit.

## Plans across the extension

The extension raises one problem the SDK does not, which is that a plan
outlives the page.

A plan spanning three operations on a site AgentDesk does not own can be
interrupted by a navigation, a session expiry, or the user closing the
tab. The shipped `PlanStore` lives in runtime memory, which is correct
for an application that owns its own lifecycle and wrong for an extension
whose content script is destroyed on navigation.

Plans in the extension therefore live in the service worker, keyed by
origin, and the content script holds a reference rather than the store.
An interrupted plan resolves to a terminal status on the next activation
of that origin rather than remaining open forever, and its unexecuted
operations are recorded as `SKIPPED` with the interruption as the detail.
That reuses `OperationOutcome` exactly as it exists.

The rule that survives from the SDK unchanged is that a plan is committed
exactly once. An extension that re-runs a plan because a content script
reloaded would double-submit a payment, so the commit-once contract in
`docs/architecture.md` is the part that must be ported first and tested
hardest.

## What this closes, and what it does not

It closes the gap where a reviewer cannot tell a governed plan from a
plan whose guarantees were structurally absent, because `PlanAssurance`
is computed, stored, and shown.

It does not make an inferred capability safe to run unattended. Nothing
in this document upgrades an assurance level. Every upgrade path in it
runs through a human writing an override, which is the same boundary
`auto-sdk.md` draws for risk. A team that wants strong plans over its own
application should install the SDK and write `previewChanges`, and this
design exists so the honest weaker version is available in the meantime
and is labelled correctly.

<!-- code-anchors
packages/webmcp/src/plan.ts OperationPlan PlannedOperation OperationOutcome expectedRevision observedRevision PlanStore
packages/webmcp/src/receipts.ts ReceiptStore
packages/webmcp/src/capability.ts previewChanges rollback approvalEvidence
-->
