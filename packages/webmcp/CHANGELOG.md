# Changelog

Notable changes to `@agentdesk/webmcp`. Entries are the pull requests merged
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

- Run AgentDesk against MCP-B's polyfill, and read both `inputSchema` arms
  ([#13](https://github.com/agentdesksdk/agentdesk/pull/13))
- PR checks and compile-time WebMCP spec conformance
  ([#1](https://github.com/agentdesksdk/agentdesk/pull/1))

### Docs

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
