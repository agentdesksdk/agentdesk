# Design notes

Design only. None of this is implemented. The direction is approved and
the contracts below are what gate building it, in place of the earlier
blanket instruction to defer everything until after a submission date. A
date is not a safety property. The gates in "Milestone gates" are.

`declarative-webmcp-findings.md` is measured behaviour of Chrome 152,
gathered over CDP. Read it first; the other documents depend on it and
several of their decisions exist because of what it showed.

`browser-extension.md` designs AgentDesk Universal, a WXT extension that
makes a site agent-capable without touching its source.

`auto-sdk.md` designs AgentDesk Auto, which generates a capability
manifest from metadata an application already has (OpenAPI, GraphQL, tRPC,
routes, forms) so `defineCapability` becomes the escape hatch rather than
the onboarding path.

`adapter-contract.md` specifies the interface a third party implements to
describe their own application: discovery, compilation, execution,
authentication, request binding, validation, receipts, and drift
detection.

`frappe-adapter.md` designs the third staging adapter, over Frappe, written
against the staging contract as it stands after the IndexedDB and REST
adapters: fork is a draft, diff is derived from the draft with the Version
doctype as the audit Frappe already keeps, commit is submit behind a
modified-stamp check, and an amended-cancel cycle is what a plan means
there.

`roadmap.md` sequences the work after PR #20 into three waves and four
lanes, with the SDK work serialized as one stack because every guarantee
lands in `runtime.ts`, and a per-PR review checklist.

`operation-plan.md` specifies what happens to the shipped plan machinery
when the capability was generated or inferred rather than authored, which
is the case where every guarantee that depends on an author-supplied
function degrades.

The four share one spine, and one earlier claim about that spine was too
strong. Both producers make capabilities that route, apply policy, and
audit exactly like authored ones, because `Capability.execute` is an
arbitrary function. What is not free is the boundary underneath.
`createAgentDeskRuntime` used to construct the WebMCP adapter and the tool
surface itself; the `CapabilityProvider` seam in `packages/webmcp/src/provider.ts`
has since been extracted, milestone 3 below, so the native SDK and the
extension can share governance. And a
generated manifest cannot feed the runtime unchanged, because
`defineCapability` refuses a consequential capability that offers a human
no evidence to approve. A compiler sits between them.

Routing, availability, policy, approval, and audit are untouched. The
provider boundary and the manifest compiler are not.

Three positions in these documents are arguments, not neutral summaries,
and are flagged here so a reader can disagree with them directly.

Numeric confidence scores are rejected in favour of discrete provenance
tiers, because a float invites threshold tuning and implies calibration
nobody measured.

The eleven-package framework matrix is cut to one discovery adapter until
the manifest contract has survived contact with a real specification.

The extension's registration path is treated as unproven rather than
assumed. Chrome documents that extensions may query and execute WebMCP
tools; an extension registering one is undocumented everywhere. One
experiment settles it and belongs ahead of any product work.

## What already shipped

One of the four capabilities a competitive review raised was not a design
problem. Acting on behalf of a named actor with a reviewable plan and a
provable record of what changed was a missing runtime surface, and it
shipped. Versioned plans, drift detection, post-write verification,
queryable receipt history, and rollback are in `packages/webmcp` and
documented in `docs/architecture.md`.

`operation-plan.md` exists because those guarantees were built for
capabilities an application author wrote, and the other three items in
this directory produce capabilities nobody wrote.

## Milestone gates

Each gate is a fact someone can check, and the order is load-bearing.
Later work assumes earlier answers, so skipping a gate means building on
an assumption rather than a result.

| # | Milestone | Gate |
| --- | --- | --- |
| 1 | Correct the design documents | `node scripts/check-design-docs.mjs` passes |
| 2 | Prove extension registration and permissions in Chrome | The ISOLATED `registerTool` experiment has a written result in `declarative-webmcp-findings.md`, and a built `manifest.json` requests no host permission at install |
| 3 | Extract the provider boundary | `createAgentDeskRuntime` takes a `CapabilityProvider` and constructs no WebMCP-specific object; the existing suite passes unchanged |
| 4 | Build extension-owned bootstrap virtualization | On one opt-in origin, the four `agentdesk_*` tools are registered by the extension and a form-derived call produces `filled`, `submitted`, and `abandoned` records |
| 5 | Add the OpenAPI compiler | `compileManifestEntry` rejects a consequential entry with no approval evidence, and a real public specification compiles with its skipped operations listed |
| 6 | Add versioned operation plans and verified receipts | A generated capability produces a plan carrying `PlanAssurance`, and a receipt carrying `sourceDigest` with no credential in it |
| 7 | Demonstrate one real third-party application adapter | Someone outside the project builds an adapter from `adapter-contract.md` alone |

Gate 2 is the one that can change the architecture. If ISOLATED
registration fails and MAIN world is excluded, milestone 4 ships
declarative forms with completion accounting and does not promise
bootstrap virtualization at all. That branch is specified in
`browser-extension.md` and is a real product rather than a failure state.

Gate 7 is the only one that cannot be checked from inside this repository,
and that is deliberate. An adapter contract nobody outside the project has
implemented is a plan for a contract.

## The accessibility contract constrains the extension

A second review, against AccessLint's Prove It, raised focus handoff and
navigable receipts. Those are runtime properties, so they were built rather
than deferred. See `docs/accessibility.md`.

One consequence lands squarely on the deferred work and is recorded here so
it is not rediscovered later. AgentDesk moves keyboard focus only to an
application-registered reveal target, and only when the human authorized
that specific execution. There is deliberately no tool that accepts a CSS
selector, because a selector-taking tool hands an agent the ability to move
a person's focus anywhere on the page.

`browser-extension.md` is where that guarantee is hardest to keep. An
extension that adapts a site it does not own has no application author to
register reveal targets, so it would have to infer them. Inferred targets
are exactly the arbitrary-selector case the runtime refuses. The extension
design therefore needs a registration step that a human confirms once per
site, and it cannot silently promote an inferred anchor into a focus
target. Whatever else changes in that design, this constraint holds.
