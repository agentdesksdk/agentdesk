# P1: Plan approval is attributed to the requesting agent

Status: OPEN

Reviewed commit: `812e5b9`

## Finding

`approvePlan()` stores the ambient runtime actor as `approvedBy`. In the normal AgentDesk configuration that actor is the agent. A plan requested and approved without changing global actor state therefore records the same agent as both requester and authorizer.

The architecture describes `approvedBy` as the person who authorized a plan and says callers cannot edit a plan a human already reviewed. The implementation does not enforce or represent that human boundary.

## Evidence

A runtime configured with the demo's agent actor prepared and approved one WRITE plan.

```json
{
  "requestedBy": {
    "id": "agent",
    "name": "Agent",
    "kind": "agent"
  },
  "approvedBy": {
    "id": "agent",
    "name": "Agent",
    "kind": "agent"
  }
}
```

The current plan tests approve under an agent fixture, so they preserve the incorrect provenance rather than detect it.

## Affected code

- `packages/webmcp/src/runtime.ts`, `approvePlan()`
- `packages/webmcp/src/plan.ts`, `approvedBy`
- `packages/webmcp/tests/plans.test.ts`
- `docs/architecture.md`, plan authorization claims

## Required behavior

- Make the approving identity explicit at `approvePlan()`, or require the current actor to be human.
- Reject approval when no human authorizer is available.
- Keep `requestedBy`, `approvedBy`, and `executedBy` independent.
- Record the approver on the `plan_approved` audit event as well as the plan.
- Do not require callers to mutate global actor state around an approval click.

## Regression test

Prepare a plan as an agent. Assert that approving without a human identity is rejected. Approve it with a human actor, then commit as the agent. Assert that `requestedBy` and `executedBy` name the agent while `approvedBy` and the approval audit event name the human.

