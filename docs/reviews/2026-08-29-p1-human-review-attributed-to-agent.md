# P1: Human review is attributed to the agent

Status: RESOLVED on `fix/acting-identity`

Reviewed commit: `6a1745e`

Validated: `packages/webmcp/tests/acting-identity.test.ts` passed on
`fix/acting-identity`, 7 of 7, alongside the full 333-test suite. The
remaining condition is closed: `receipt_reviewed` now carries the resolved
reviewer on an `actor` field, so an exported audit stream answers who
reviewed without joining back to the receipt store. The event records
`operator-1` with `kind: "human"` where it previously recorded nothing.

## Post-fix validation

`2f1f332` rejects an omitted or non-human reviewer and makes the demo pass an explicit human operator. The focused regression tests pass.

One acceptance condition remained open after `2f1f332`. The `receipt_reviewed` audit event carried only `capability` and `receiptId`. It did not record the human reviewer. The receipt store had `reviewedBy`, but an exported audit stream still could not answer who performed the review. That condition is closed above.

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
