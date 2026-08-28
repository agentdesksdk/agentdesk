# @agentdesk/webmcp

Capability-virtualization runtime for WebMCP pages. Register a large
capability catalog once; publish only the relevant few as typed native
tools, with structured availability reasons, human approval for
consequential actions, and an audit trail.

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

No React dependency. Only `webmcp-adapter.ts` touches
`document.modelContext`; tests enforce the boundary. See
`../../docs/architecture.md`.
