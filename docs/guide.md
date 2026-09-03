# Operator guide

Running, demonstrating, measuring, and deploying AgentDesk. The design itself
is in [architecture.md](architecture.md); the WebMCP surface in
[webmcp-runtime.md](webmcp-runtime.md).

## Demo: Meridian Ops

A fictional operations console (customers, orders, inventory, shipping,
billing, support, reports) with a deterministic seeded dataset, running
entirely in the browser.

Hero prompt:

> Find Alice Johnson's unshipped order. If she paid shipping, refund the
> shipping fee. Do not perform the refund without my approval.

Order **#10428** is seeded: processing, not shipped, $18.00 shipping paid,
not refunded. The flow shows routing (78 → ≤6), typed native activation, the
approval card, the audit timeline, and the state change. **Reset Demo**
restores the pristine seed instantly.

The step-by-step hero flow, and how to drive it without a WebMCP client, is
in [testing.md](testing.md#hero-flow-demo-app).

## Baseline experiment

The same catalog powers two routes:

- **`/baseline`** — control condition: every applicable capability
  registered as a flat WebMCP surface. A permanent banner marks it.
- **`/agentdesk`** — bootstrap + routed working set.

Same capabilities, same handlers, different exposure. The Benchmark panel
measures catalog size, active tool count, serialized schema bytes (from the
actual registered definitions), invocations, stale calls, and elapsed task
time per run. Token figures are labelled estimates (bytes ÷ 4, same
estimator both modes). See [benchmark.md](benchmark.md).

## Repository layout

```text
packages/webmcp     @agentdesksdk/webmcp — the SDK. No React, no DOM deps
                    beyond document.modelContext behind one adapter.
apps/demo           Meridian Ops (Vite + React 19). React observes only.
apps/p0             Bare HTML/TS browser-compatibility harness (/p0/).
docs/               architecture, runtime notes, benchmark, testing.
```

Invariants (enforced by tests, detailed in [architecture.md](architecture.md)):
only the adapter touches `document.modelContext`; only ToolSurfaceManager
registers tools; native and compatibility calls share one pipeline;
availability is re-checked at execution and approval time; consequential
calls return immediately with an `approval_id`.

## Installing the SDK

The runtime is published as [`@agentdesksdk/webmcp`](https://www.npmjs.com/package/@agentdesksdk/webmcp).
It has no runtime dependencies and needs Node 18 or newer:

```bash
npm install @agentdesksdk/webmcp
```

The package README shows the first capability; [webmcp-runtime.md](webmcp-runtime.md)
explains what registering it does. Release notes are in
[`packages/webmcp/CHANGELOG.md`](../packages/webmcp/CHANGELOG.md).

## Running locally

```bash
pnpm install
pnpm dev     # demo app  → http://127.0.0.1:4178
pnpm p0      # P0 harness → http://127.0.0.1:4177/p0/
```

## Testing

```bash
pnpm test
pnpm typecheck
pnpm build
```

Coverage and the manual browser checklist are in [testing.md](testing.md).

## Deployment

Static. `pnpm build` produces `apps/demo/dist` with the P0 harness copied to
`/p0/`. `netlify.toml` and `vercel.json` are included with SPA fallbacks:

```bash
netlify deploy --prod    # or: vercel deploy --prod
```

No environment variables, no secrets, no server.

Once deployed, replace the `https://<LIVE_URL_PLACEHOLDER>` line at the top
of the README with the real URL.
