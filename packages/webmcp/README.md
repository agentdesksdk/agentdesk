# @agentdesk/webmcp

Capability-virtualization runtime for WebMCP pages. Register a large
capability catalog once; publish only the relevant few as typed native
tools, with structured availability reasons, human approval for
consequential actions, and an audit trail.

## Installing

```bash
npm install @agentdesk/webmcp
```

No runtime dependencies; Node 18 or newer.

```ts
import { createAgentDeskRuntime, defineCapability } from "@agentdesk/webmcp";

const runtime = createAgentDeskRuntime({
  capabilities: [
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      domain: "shipping",
      intents: ["refund shipping"],
      risk: "CONSEQUENTIAL",
      inputSchema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" } } },
      execute: (input) => performRefund(input),
    }),
  ],
});
await runtime.start(); // registers get_context, find_capabilities, invoke_capability, get_action_status
```

- `runtime.setContext({ route, state })` — reconcile the surface as the app
  navigates.
- `runtime.setExposure("flat" | "routed")` — baseline vs virtualized.
- `runtime.approve(id)` / `runtime.reject(id)` — resolve pending
  consequential actions (approval re-checks availability first).
- `runtime.subscribe(listener)` — UI snapshots; unsubscribing never
  unregisters tools.
- `runtime.subscribeAudit(listener)` — stream events to your observability
  backend; `toObservabilityEvent()` maps them to a versioned envelope.
- `runtime.subscribePresentation(listener)` — optional UI choreography.

## Handlers get the execution context

```ts
execute: async (input, { signal, executionId, route, state }) =>
  fetch("/api/refund", { method: "POST", signal }),
```

`signal` is the WebMCP execution signal linked with the runtime lifecycle,
so it aborts when the client cancels or the runtime is reset.

## Swap the pieces you disagree with

```ts
createAgentDeskRuntime({
  capabilities,
  validate: ajvValidator,          // default: bundled JSON Schema subset
  policy: ({ capability, input }) => // default: riskBasedPolicy
    Number(input.amount) > 500
      ? { kind: "deny", reason: "Refunds above $500 need a manager." }
      : { kind: "allow" },
  exposedTo: ["https://agent.example"], // spec: registerTool exposedTo
});
```

Consuming other pages' tools is a separate, optional role:

```ts
import { createWebMcpClient } from "@agentdesk/webmcp";
const client = createWebMcpClient();
if (client.features.getTools) {
  const listed = await client.listTools({ fromOrigins: ["https://shop.example"] });
}
```

No React dependency. Only `webmcp-adapter.ts` touches
`document.modelContext`; tests enforce the boundary. See
`../../docs/architecture.md`.
