# P1: Single-action approval has no approver identity

Status: OPEN

Reviewed commit: `2f1f332`

## Finding

`approve(actionId)` records that an approval happened but has no parameter or session hook for the human who authorized it. The `approval_approved` audit event contains only the action ID and capability. The resulting receipt correctly names the agent as executor, but there is no durable link to the person who clicked **Approve**.

Changing the runtime's ambient actor before approval is not a valid workaround. That same actor is used by `runExecution()`, so it would falsely attribute the agent's execution to the human.

## Evidence

The live approval path was reproduced with the runtime actor set to the agent:

```json
{
  "approvalAudit": {
    "kind": "approval_approved",
    "actionId": "APR-1001",
    "capability": "refund"
  },
  "receiptExecutedBy": {
    "id": "agent",
    "kind": "agent"
  }
}
```

The UI labels this event **Human approved**, but the governance record cannot establish which human approved it.

## Affected code

- `packages/webmcp/src/runtime.ts`, `approve(actionId)`
- `packages/webmcp/src/audit.ts`, `approval_approved`
- `apps/demo/src/components/ApprovalCards.tsx`, approval click

## Required behavior

- Let the approval call carry an explicit human authorizer or derive one from an authenticated application session.
- Reject a human-approval operation when no human identity is available.
- Record the authorizer on the approval record and `approval_approved` audit event.
- Keep execution identity separate, so the receipt still names the agent that ran the capability.
- Apply the same identity model to rejection.

## Regression test

Request a consequential action as an agent. Assert that approval without a human identity is rejected. Approve with a human actor, execute as the agent, and assert that the approval audit names the human while the execution audit and receipt name the agent.

