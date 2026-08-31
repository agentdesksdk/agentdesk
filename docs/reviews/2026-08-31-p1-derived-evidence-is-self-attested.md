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
