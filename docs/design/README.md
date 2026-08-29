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
