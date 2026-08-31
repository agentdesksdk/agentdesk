# P1: derived approval evidence is self-attested

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, detached at `2bc6f6a`, with Agent 4's uncommitted staging changes

## Finding

The SDK adds `"derived"` as a public `approvalEvidence` string. Any capability
author can pair that string with an ordinary hand-written `previewChanges`.
`defineCapability` checks only that a preview exists, so the runtime cannot
distinguish a branch-derived artifact from the same advisory diff it labels
`"diff"`.

The README and architecture claim callers can rely on `"derived"` to mean the
handler produced the preview. The implementation makes that an author claim,
not a runtime guarantee.

## Required correction

Do not expose a stronger evidence label without a stronger protocol. Either
keep this application-specific work labeled `diff`, or model a staged proposal
as an opaque runtime-owned artifact whose preview and commit are inseparable.
The public type should make it impossible to select `derived` while supplying
an unrelated preview callback.

## Regression requirement

Attempt to construct a consequential capability with `approvalEvidence:
"derived"` and an ordinary preview callback. Construction must fail unless the
runtime received the corresponding staged-proposal implementation.

## Resolution

`CapabilitySpec` is a union of `DirectCapabilitySpec` and
`StagedCapabilitySpec`. The staged variant carries `stage` and forbids
`execute`, `previewChanges`, and `approvalEvidence`; the direct variant
forbids `stage` and can select only `diff` or `summary`. `derived` is absent
from the public spec entirely and is set by `defineCapability` only for a
capability that declared `stage`. A JavaScript caller that supplies the
string anyway is refused, as is a spec pairing `stage` with a preview
callback or a second handler.

Covered by `packages/webmcp/tests/staged-proposals.test.ts`.

## Re-review at `0c4f2fa`

The public evidence string is now closed, but the stronger guarantee is not.
`StageHandler` is public and returns a public `StagedProposal` containing both
`changes` and `commit`. A capability author can therefore return a hand-written
diff whose commit performs unrelated work. `defineCapability` then assigns
`approvalEvidence: "derived"` without any runtime-owned derivation or opaque
brand proving that the two came from the same staged state.

For example, the current API accepts a proposal whose changes say a refund flag
will change while its commit deletes a customer. The runtime owns the proposal's
lifecycle after construction; it does not own or verify its evidence.

Keep this finding open until generic staged capabilities are labeled only
`diff`, or until `derived` can be produced only by a runtime-owned staging
adapter/factory that derives the changes and the commit from one opaque staged
artifact. Add a regression that attempts to manufacture a proposal with an
unrelated diff and commit through the public API.

## Resolution at `97cc9b6`

`StageHandler` is no longer author-supplied. `StagedCapabilitySpec` takes
`staging: { adapter, write }`, and `defineCapability` builds the proposal
itself with `buildStageHandler`. The author writes only the handler; the
`changes` on the approval card and the `commit` that lands are both derived by
the runtime from the single opaque artifact `adapter.fork` returned. Supplying
a `stage` handler directly is refused, as is an adapter missing any of `fork`,
`diff`, `commit`, or `release`.

The example in the re-review is now unconstructible. A handler that returns a
diff-shaped value cannot influence the preview, because the preview comes from
`adapter.diff` over the artifact rather than from anything the handler
returned.

Covered by `packages/webmcp/tests/staged-lifecycle.test.ts`, which attempts to
manufacture a proposal with an unrelated diff and commit through the public
API and is refused, and which shows a handler misreporting its own write while
the card still displays what the fork actually recorded.

What this does and does not prove, stated plainly. The capability author
cannot fabricate evidence at all. The adapter author still can, because
`diff` and `commit` are their code. The adapter is one audited integration
point per application rather than per-capability code, which is the strongest
guarantee available without the SDK owning the application's data layer.

## Re-review at `798c899`

The capability author and the adapter author are not separate principals in
the public API. Every `StagedCapabilitySpec` carries its own public
`staging.adapter`, so the same caller that declares the capability can supply
an inline adapter whose `diff` describes one change and whose `commit` performs
another. `defineCapability` accepts it and assigns `approvalEvidence:
"derived"`.

This was reproduced against the built package. The approval card showed
`status: safe -> approved`; approval then ran the same capability's adapter and
set live state to `deleted-everything`. Removing direct `stage` construction
moved self-attestation from the proposal to the adapter but did not establish a
trusted boundary.

Keep this finding open until the application adapter is bound once at runtime
construction or through an opaque factory that a capability cannot replace.
The capability declaration should supply only its staged write. At minimum,
generic caller-supplied adapters cannot receive the stronger `derived` label.

Add a regression using only the public package API that declares an inline
adapter with a mismatched diff and commit. Construction or runtime startup must
refuse it, or the result must not claim `derived` evidence.

## Resolution at `4a4dbf1`

The adapter is bound once, at `createAgentDeskRuntime`. `StagedCapabilitySpec`
carries `staging: { write }` and nothing else; supplying `staging.adapter`
alongside it is refused by `defineCapability`, and supplying `stage` directly
still is. A capability declares only its write, so the code that describes a
change and the code that performs it are no longer both under the control of
whoever declared the operation.

`start()` refuses when any staged capability is registered and no adapter is
bound, and refuses an adapter missing `scope`, `fork`, `diff`, `commit`, or
`release`. The plan path uses `adapter.scope`, which absorbed the former
`stagingScope` option, so there is one staging boundary rather than two.

The reproduction in the re-review no longer compiles or runs. A regression
declares an inline adapter beside a write and is refused; another has a
handler try to report `untouched` while writing `deleted-everything`, and the
card shows `deleted-everything`, because the diff comes from the runtime's
adapter over the artifact.

What this proves, stated exactly. A capability author cannot influence its own
evidence at all. The application that constructs the runtime still supplies
the adapter, and an adapter whose `diff` disagrees with its `commit` can still
lie. That is one audited integration point chosen at composition time rather
than per-operation code, which is the strongest separation available without
the SDK owning the application's data layer.
