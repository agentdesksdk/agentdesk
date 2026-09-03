# Changelog

Notable changes to `@agentdesksdk/webmcp`. Entries are the pull requests merged
to `main`, newest first within each group. A release is cut by pushing a
`v<version>` tag that matches the version in `package.json`; the workflow in
`.github/workflows/release.yml` refuses anything else.

## Unreleased

Nothing yet.

## 0.2.0

First published version. 0.1.0 was the hackathon build and never reached
npm. This release is the built, spec-complete SDK surface and everything
merged since it.

### Features

- The domain step ships single-domain, with the near-tie a parameter,
  measured on both seeds ([#74](https://github.com/agentdesksdk/agentdesk/pull/74))
- A provider's refusal is one audit event, `provider_refused`, and the
  bridge keeps no log ([#72](https://github.com/agentdesksdk/agentdesk/pull/72))
- The extension's first slice, a `CapabilityProvider` over a validated
  bridge; the package is private and does not publish
  ([#70](https://github.com/agentdesksdk/agentdesk/pull/70))
- The Inspector shows the catalog's domains after a first-level call, and a
  press narrows the second call to one
  ([#69](https://github.com/agentdesksdk/agentdesk/pull/69))
- `createAgentDeskRuntime` takes a `CapabilityProvider` and constructs no
  WebMCP-specific object ([#68](https://github.com/agentdesksdk/agentdesk/pull/68))
- The eval page serves the result shape the runner measures
  ([#66](https://github.com/agentdesksdk/agentdesk/pull/66))
- `find_capabilities` narrows through a domain tree, with no model on the
  page ([#65](https://github.com/agentdesksdk/agentdesk/pull/65))
- Await a staged commit, so a store that answers later answers first
  ([#55](https://github.com/agentdesksdk/agentdesk/pull/55))
- A staging adapter over IndexedDB, with optimistic concurrency
  ([#53](https://github.com/agentdesksdk/agentdesk/pull/53))
- A page replays a reveal through the runtime's own presentation bus
  ([#49](https://github.com/agentdesksdk/agentdesk/pull/49))
- The eval compares bare results against structured evidence in four cells
  ([#51](https://github.com/agentdesksdk/agentdesk/pull/51))
- Meridian Ops keeps an unknown outcome across a reload, and a person
  settles it ([#50](https://github.com/agentdesksdk/agentdesk/pull/50))
- An unknown outcome survives a restart, guards the repeat, and can still be
  closed ([#46](https://github.com/agentdesksdk/agentdesk/pull/46))
- An approval is bound to a gesture the runtime issued and can verify
  ([#44](https://github.com/agentdesksdk/agentdesk/pull/44))
- A receipt says where its proof can be seen
  ([#41](https://github.com/agentdesksdk/agentdesk/pull/41))
- The agent sees a role-shaped projection of state, the human sees
  everything ([#40](https://github.com/agentdesksdk/agentdesk/pull/40))
- A grant card and a Revoke button on the order page in Meridian Ops
  ([#38](https://github.com/agentdesksdk/agentdesk/pull/38))
- An approval is bound to a digest of the state it was reviewed against
  ([#37](https://github.com/agentdesksdk/agentdesk/pull/37))
- Scoped authority grants, spent one execution at a time
  ([#36](https://github.com/agentdesksdk/agentdesk/pull/36))
- One result protocol, and a denied capability is invisible on every path
  ([#34](https://github.com/agentdesksdk/agentdesk/pull/34))
- A visible adversarial support note on order 10428, returned as untrusted
  content ([#26](https://github.com/agentdesksdk/agentdesk/pull/26))
- Run the same task in both modes, side by side, at task-time peak
  ([#24](https://github.com/agentdesksdk/agentdesk/pull/24))
- A self-narrating overview and a visible routing decision
  ([#23](https://github.com/agentdesksdk/agentdesk/pull/23))
- An evaluation runner that refuses to invent model results
  ([#14](https://github.com/agentdesksdk/agentdesk/pull/14))
- Routing strategies, a capability graph, and a scorer seam
  ([#12](https://github.com/agentdesksdk/agentdesk/pull/12))
- Before pull requests: the production SDK surface (built package,
  spec-complete execution, validation, pluggable policy), change previews and
  verifiable receipts, versioned plans with verification and rollback, guided
  execution through a presentation trace stream, and accessible focus
  handoff with keyboard review.

### Fixes

- The npm scope is `@agentdesksdk`, the name the organization holds
  ([#75](https://github.com/agentdesksdk/agentdesk/pull/75))
- Three findings from the main pass: the durability card clears on reset, a
  spent grant reads unused, the benchmark says who approves
  ([#67](https://github.com/agentdesksdk/agentdesk/pull/67))
- The approval card reads the considered grant off the pending action, and
  the audit walk is gone ([#63](https://github.com/agentdesksdk/agentdesk/pull/63))
- The shell at 375, a page for the adversarial note, and two rail details
  ([#45](https://github.com/agentdesksdk/agentdesk/pull/45))
- A pending action carries the considered grant, and the consult names the
  most recently changed one
  ([#43](https://github.com/agentdesksdk/agentdesk/pull/43))
- The eval catalog's `ALREADY_REFUNDED` guard now runs on the input it reads
  ([#29](https://github.com/agentdesksdk/agentdesk/pull/29))
- Codepoint tie-break, one count per edge, peak surface metrics, and the
  `fromOrigins` contract ([#20](https://github.com/agentdesksdk/agentdesk/pull/20))
- Make the staged approval artifact runtime-owned and fail closed
  ([#11](https://github.com/agentdesksdk/agentdesk/pull/11))
- A thrown rollback is indeterminate; repeated announcements are spoken
  ([#9](https://github.com/agentdesksdk/agentdesk/pull/9))
- Bound executions, sessions, and approvals to what actually happened
  ([#10](https://github.com/agentdesksdk/agentdesk/pull/10))
- Capture acting identity once; require a human to approve a plan
  ([#8](https://github.com/agentdesksdk/agentdesk/pull/8))
- Presentation failures cannot corrupt a write; reviews require a human
  ([#5](https://github.com/agentdesksdk/agentdesk/pull/5))
- Claim rollbacks atomically, refuse stale undo, stop plans overreporting
  ([#2](https://github.com/agentdesksdk/agentdesk/pull/2))
- Before pull requests: the compatibility fallback no longer executes a
  write twice, `executeTool` encoding is never negotiated by retrying the
  caller's operation, and the encoding probe carries input instead of
  assuming empty is valid.

### Tests and CI

- The domain step confirmed on a second held-out set, under a rule written
  before the run ([#71](https://github.com/agentdesksdk/agentdesk/pull/71))
- The routing eval runs a scorer by name, and a custom one from a path
  ([#61](https://github.com/agentdesksdk/agentdesk/pull/61))
- A routing stress evaluation: 408 generated capabilities, 55 held-out
  phrasings, and the shipped scorer's 29.1%
  ([#59](https://github.com/agentdesksdk/agentdesk/pull/59))
- Land the five stacked wave 1 pull requests that were merged into their
  own branches ([#52](https://github.com/agentdesksdk/agentdesk/pull/52))
- Pin workflow actions to commit SHAs, package install line, repair wording
  ([#35](https://github.com/agentdesksdk/agentdesk/pull/35))
- Publish `@agentdesksdk/webmcp` on a `v*` tag with provenance
  ([#33](https://github.com/agentdesksdk/agentdesk/pull/33))
- Wave 0 review follow-ups in the demo and p0 apps
  ([#32](https://github.com/agentdesksdk/agentdesk/pull/32))
- Run AgentDesk against MCP-B's polyfill, and read both `inputSchema` arms
  ([#13](https://github.com/agentdesksdk/agentdesk/pull/13))
- PR checks and compile-time WebMCP spec conformance
  ([#1](https://github.com/agentdesksdk/agentdesk/pull/1))

### Docs

- The README's first screen carries the measured figures, held to the runs
  ([#73](https://github.com/agentdesksdk/agentdesk/pull/73))
- The Frappe staging adapter, designed against the contract
  ([#64](https://github.com/agentdesksdk/agentdesk/pull/64))
- Status after wave 1 in the roadmap and the review tracker
  ([#62](https://github.com/agentdesksdk/agentdesk/pull/62))
- Point the transcript runbook at the eval catalog page
  ([#30](https://github.com/agentdesksdk/agentdesk/pull/30),
  [#31](https://github.com/agentdesksdk/agentdesk/pull/31))
- A fifteen-minute runbook for capturing an eval transcript
  ([#25](https://github.com/agentdesksdk/agentdesk/pull/25))
- The problem, the pipeline, and the hero prompt above the README fold
  ([#22](https://github.com/agentdesksdk/agentdesk/pull/22))
- A three-wave roadmap after #20
  ([#21](https://github.com/agentdesksdk/agentdesk/pull/21))
- Bound the throwing-rollback finding to capabilities with no verifier
  ([#7](https://github.com/agentdesksdk/agentdesk/pull/7))
- Track the review records ([#6](https://github.com/agentdesksdk/agentdesk/pull/6))
- Correct eight design defects; specify the adapter and plan contracts
  ([#3](https://github.com/agentdesksdk/agentdesk/pull/3))

Also an eval page in `apps/p0` that mounts the eval catalog per arm
([#27](https://github.com/agentdesksdk/agentdesk/pull/27)); it lives in the
harness, not the package.

## 0.1.0

Hackathon build. Not published.
