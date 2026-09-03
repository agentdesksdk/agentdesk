# AgentDesk

**A capability-virtualization runtime for WebMCP applications.**

WebMCP gives websites tools. AgentDesk exposes the right tools at the right
time, explains capability state, and keeps consequential actions under human
control.

A real application has dozens or hundreds of operations. Register them all as
WebMCP tools and the agent gets a flat, expensive, ambiguous surface: our
demo catalog alone is 78 capabilities and tens of kilobytes of schema before
the agent has done anything. Big surfaces cost context, invite wrong-tool
calls, and make dangerous actions look exactly like safe ones.

```text
the agent proposes              typed tools, ≤6 at a time; a write stages on a fork of app state
the human authorizes            approves the diff read off that fork, not a description of it
AgentDesk enforces and proves   commits that same fork, re-checked, into an audit timeline
```

## Measured, not claimed

- Surface: on the eval catalog the routed arm hands the agent 7 visible
  tools and 2,486 schema bytes against 51 and 10,455 flat
  ([reference run](docs/evaluations.md#reference-run)).
- Result shape: a structured result costs 464 bytes against 67 bare, and
  carries an evidence link on 100.0% of consequential completions against
  0.0% ([the two axes](docs/evaluations.md#the-two-axes)).
- Routing on a real-sized catalog: the shipped scorer routes the expected
  capability for 29.1% of held-out tasks; the domain step, 34.5%, confirmed
  at 36.4% on a second seed
  ([routing stress evaluation](docs/evaluations.md#routing-stress-evaluation)).
- Tool selection, argument accuracy, and task completion are model
  decisions and are `unavailable` until someone records a transcript;
  the runbook is [Capturing a transcript](docs/evaluations.md#capturing-a-transcript).

Every figure above is read from a committed `report.json` under
`scripts/evals/runs` by `pnpm check:docs`, which fails if a sentence here
stops agreeing with its run.

**Live demo:** <https://webmcp.agentsdesk.dev> (see
[docs/guide.md](docs/guide.md#deployment))

Hero prompt, against the seeded Meridian Ops console:

> Find Alice Johnson's unshipped order. If she paid shipping, refund the
> shipping fee. Do not perform the refund without my approval.

Built for the OpenAI WebMCP Challenge. TypeScript, no backend, no model API,
static deployment.

## Read next

- [docs/guide.md](docs/guide.md) — the Meridian Ops demo, the baseline
  experiment, repository layout, running locally, testing, deployment.
- [docs/webmcp-runtime.md](docs/webmcp-runtime.md) — native mode,
  compatibility mode, retired tools, and the approval state machine.
- [docs/architecture.md](docs/architecture.md) — invariants, staged
  proposals (the human approves the operation, not a description of it),
  guided execution, plans, verification, and rollback.
- [docs/testing.md](docs/testing.md) — automated coverage and the measured
  client matrix (Codex, Chrome 152, ChatGPT).
- [docs/benchmark.md](docs/benchmark.md) and
  [docs/evaluations.md](docs/evaluations.md) — what is measured, what is
  estimated, and what is deliberately not claimed.
- [docs/routing.md](docs/routing.md), [docs/mcp-b-interop.md](docs/mcp-b-interop.md),
  [docs/accessibility.md](docs/accessibility.md),
  [docs/future-directions.md](docs/future-directions.md).

## How it works

```text
large internal capability catalog (78)
  → context-aware deterministic router
  → dynamic native WebMCP registration (≤6 typed tools at a time)
  → availability with structured reasons + a checked repair (which capability to call, with what input)
  → risk policy: READ / WRITE execute, CONSEQUENTIAL needs a human
  → two-phase approval that never blocks a WebMCP call
  → audit timeline of everything
```

The agent always sees four bootstrap tools: `get_context`,
`find_capabilities`, `invoke_capability`, `get_action_status`. Calling
`find_capabilities` with a task routes the catalog, registers the few
relevant capabilities as real typed native tools, retires the rest, and
explains anything relevant-but-unavailable.

## Why WebMCP

This is a WebMCP-native implementation, not an MCP bridge. The runtime
registers typed tools directly on the page's `document.modelContext`, uses
`AbortController` signals for retirement, and treats the browser page as the
single source of capability truth. No local daemon, no gateway, no server.

## A capability that writes supplies no code

An author-written preview is a second description of an operation, and two
descriptions drift. So a capability that writes does not describe its change.
It names an operation the adapter owns, the runtime stages it on a fork of
application state, and the diff the human approves is read off that fork.
This example is compiled by `pnpm typecheck`
(`packages/webmcp/examples/staged-capability.ts`), and `pnpm check:docs`
fails if it drifts from what the runtime accepts:

```ts
const refundShipping = defineCapability({
  name: "refund_shipping",
  description: "Refund the shipping fee for an order.",
  risk: "CONSEQUENTIAL",
  // No execute, no previewChanges, no approvalEvidence, no code at all. The
  // capability names an operation the adapter owns and the runtime hands it
  // the validated input.
  staging: { operation: "refund_shipping" },
});

const runtime = createAgentDeskRuntime({
  capabilities: [refundShipping],
  // Bound once. The adapter owns the operations, the diff, and the commit,
  // so a capability can neither describe its own change nor reach live state
  // outside the fork this opens.
  staging: meridianStaging,
});
```

The full contract, including what happens when a commit throws, when the
human edits the same record while an approval is pending, and how plans
stage several operations in one scope, is in
[docs/architecture.md](docs/architecture.md#the-human-approves-the-operation-not-a-description-of-it).

## License

MIT — see [LICENSE](LICENSE).
