# P1: Human review is attributed to the agent

Status: PARTIALLY FIXED in `2f1f332`

Reviewed commit: `6a1745e`

## Post-fix validation

`2f1f332` rejects an omitted or non-human reviewer and makes the demo pass an explicit human operator. The focused regression tests pass.

One acceptance condition remains open. The `receipt_reviewed` audit event still carries only `capability` and `receiptId`. It does not record the human reviewer. The receipt store has `reviewedBy`, but an exported audit stream still cannot answer who performed the review.

## Finding

The demo configures the runtime actor as `{ id: "agent", kind: "agent" }`. The Activity panel calls `agentdesk.markReviewed(entry.id)` without a reviewer. The SDK fills the omitted reviewer with the ambient runtime actor. A human clicking **Mark reviewed** therefore records the agent as the reviewer.

This makes the new review provenance false at the point where it is meant to establish human oversight.

## Evidence

The live AgentDesk flow was exercised through native WebMCP:

1. Route the Alice shipping-refund task.
2. Request `refund_shipping` for order `10428`.
3. Approve in the application UI.
4. Click the receipt's keyboard-operable **Mark reviewed** button.

The SDK behavior was then isolated with the same ambient actor and an omitted `by` argument:

```json
{
  "marked": { "ok": true },
  "reviewer": {
    "id": "agent",
    "name": "Agent",
    "kind": "agent"
  }
}
```

The accessibility test misses this because its fixture configures the runtime actor as a human.

## Affected code

- `apps/demo/src/runtime/agentdesk.ts`, runtime actor configuration
- `apps/demo/src/components/ActivityPanel.tsx`, `markReviewed(entry.id)`
- `packages/webmcp/src/runtime.ts`, `markReviewed(receiptId, by)` fallback to `actor`
- `packages/webmcp/tests/accessibility.test.ts`, human-only fixture

## Required behavior

- A human review action must require or derive a human reviewer identity.
- Do not silently fall back to an agent actor for a user-interface review.
- Preserve separate execution and review identities in stored receipts and audit events.
- Reject a review when no human identity is available, or make the demo pass an explicit human actor from its user session.

## Regression tests

Add an end-to-end-shaped test with the demo's actual ambient agent actor. Simulate the Activity panel call and assert that the review is either rejected for missing human identity or stored with an explicit human reviewer. Also assert that execution provenance remains attributed to the agent.
