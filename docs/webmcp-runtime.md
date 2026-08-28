# WebMCP runtime notes

## Native registration

The adapter is deliberately thin. This is the actual integration point
(`packages/webmcp/src/webmcp-adapter.ts`):

```ts
const native = (globalThis as ModelContextHost).document?.modelContext;
...
return {
  supported: true,
  registerTool: (tool, options) => native.registerTool(tool, options),
};
```

`ToolSurfaceManager.registerLive` calls it with a typed definition and an
abort signal:

```ts
const controller = new AbortController();
await this.adapter.registerTool(
  {
    name: capability.name,
    title: capability.title,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: capability.annotations,
    execute: async (input) => executor(capability, asRecord(input)),
  },
  { signal: controller.signal },
);
```

Aborting the controller unregisters the tool. Every registered tool keeps its
serialized definition length, so the "schema bytes" figure in the demo is
measured from what was actually registered, not estimated.

## Bootstrap surface

Registered at document startup and never retired:

| Tool | Purpose |
| --- | --- |
| `get_context` | Route, focused entities, active tools, pending approvals |
| `find_capabilities` | Route a task; activates a ≤6-tool working set; explains unavailable matches |
| `invoke_capability` | Compatibility execution by name; same pipeline as native tools |
| `get_action_status` | Poll a pending approval by `approval_id` |

## Routing

Deterministic weighted scoring, no embeddings
(`packages/webmcp/src/router.ts`):

```text
intent match   × 5   (all words of an intent phrase appear in the query)
domain match   × 4   (query token or current UI domain)
entity match   × 3   (a declared entity key is present in context state)
keyword match  × 2   (per matched keyword, capped at 2 keywords)
route match    × 1   (route prefix)
```

Zero-score capabilities are never routed. Top 5 by default, hard cap 6.
Page context materially changes results: with `orderId` in context state,
order-scoped capabilities (`inspect_order`, `refund_shipping`) outrank
generic search.

## Retired tools

Clients cache tool lists. When a routed tool leaves the working set, its
registration is aborted and a tombstone with the same name is registered.
A stale call reaches the tombstone and gets:

```json
{
  "status": "TOOL_RETIRED",
  "capability": "search_customer",
  "reason": "Application context changed and this capability is no longer part of the active tool surface.",
  "next": "Call find_capabilities with the current task."
}
```

The next `find_capabilities` call clears tombstones and reconciles a fresh
working set.

## Two-phase approval

```text
agent: refund_shipping {order_id: "10428"}
  └─ policy: CONSEQUENTIAL → pending action APR-1001
     returns immediately:
     { status: "APPROVAL_REQUIRED", approval_id: "APR-1001",
       risk: "CONSEQUENTIAL",
       summary: "Refund $18.00 shipping for Order #10428 (Alice Johnson)." }

human: clicks Approve in the page
  └─ re-check availability + input pre-flight → execute → audit
     record: { status: "APPROVED_EXECUTED", result: { shipping_refunded: true, amount: 18 } }

agent: get_action_status {approval_id: "APR-1001"}
  └─ { status: "APPROVED_EXECUTED", result: ... }
```

Rejection resolves the record as `REJECTED` with zero side effects. If state
changed while pending (e.g. the fee was already refunded), approval fails
closed as `FAILED_UNAVAILABLE` with the reason code.
