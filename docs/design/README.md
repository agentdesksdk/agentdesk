# Design notes

Design only. None of this is implemented, and none of it should be built
before the hackathon submission ships.

`declarative-webmcp-findings.md` is measured behaviour of Chrome 152,
gathered over CDP. Read it first; the other two documents depend on it and
several of their decisions exist because of what it showed.

`browser-extension.md` designs AgentDesk Universal, a WXT extension that
makes a site agent-capable without touching its source.

`auto-sdk.md` designs AgentDesk Auto, which generates a capability
manifest from metadata an application already has (OpenAPI, GraphQL, tRPC,
routes, forms) so `defineCapability` becomes the escape hatch rather than
the onboarding path.

The two share one spine. Both produce capabilities that feed the existing
runtime unchanged, because `Capability.execute` is an arbitrary function
and the runtime already takes an injectable adapter. Neither needs the
routing, policy, approval, or audit layers to change.

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

## What stays deferred

A competitive review raised four capabilities that AgentDesk does not have.
Three of them are already designed here and stay deferred. Building any of
them now would trade a working submission for an unfinished one.

Making a non-agentic site agent-capable without touching its source is
`browser-extension.md`. Discovering legacy forms and buttons and turning
them into capabilities is the same document. Generating a capability
manifest from metadata an application already has is `auto-sdk.md`. An
adapter contract that lets third parties describe their own applications
depends on that manifest surviving contact with a real specification, which
has not happened.

The fourth, acting on behalf of a named actor with a reviewable plan and a
provable record of what changed, was not a design problem. It was a missing
runtime surface, and it shipped. Versioned plans, drift detection,
post-write verification, queryable receipt history, and rollback are in
`packages/webmcp` and documented in `docs/architecture.md`.

The line between the two groups is whether the work needs a browser
extension or a code generator. Everything that does is deferred. Everything
that is a property of the runtime itself was in scope and is done.

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
