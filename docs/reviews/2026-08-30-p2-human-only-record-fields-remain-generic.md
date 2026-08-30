# P2: human-only record fields remain typed as generic actors

Status: RESOLVED on `fix/acting-identity`

Reviewed branch: `fix/acting-identity` at `d7a4911`

Validated: `packages/webmcp/tests/actor-parsing.test.ts` passed on
`fix/acting-identity`, 4 of 4, alongside the full 343-test suite, and all
three TypeScript projects typechecked. `OperationPlan.approvedBy`,
`StoredReceipt.reviewedBy`, and the `by` parameter of
`ReceiptStore.markReviewed` are now `HumanActor`. `PlanStore.resolve` keeps
its `Partial<OperationPlan>` patch type, so the change binds every internal
caller rather than only the runtime entry point. `requestedBy` and
`executedBy` stay `Actor`, because an agent legitimately asks for a plan and
legitimately performs a write. The two `@ts-expect-error` directives that
assign an agent to `approvedBy` and to `reviewedBy` are now satisfied
instead of reported unused, and no `as HumanActor` assertion exists anywhere
in the repository.

## Finding

The patch correctly changes `plan_approved.actor` and `receipt_reviewed.actor` to `HumanActor`, but the domain records that carry the same decisions remain weaker:

- `OperationPlan.approvedBy?: Actor`
- `StoredReceipt.reviewedBy?: Actor`
- `ReceiptStore.markReviewed(..., by?: Actor)`

A compile-only probe assigning `{ id: "agent-1", kind: "agent" }` to both `NonNullable<OperationPlan["approvedBy"]>` and `NonNullable<StoredReceipt["reviewedBy"]>` exits with code 0. The type system still permits an agent to occupy fields whose runtime contract says a human made the decision.

## Required correction

Use `HumanActor` for `approvedBy`, `reviewedBy`, and the internal store methods that populate them. Derive audit event actor types from those authoritative fields where practical so the guarantee cannot drift between records.

## Regression requirement

Add compile-time assertions that an agent actor is rejected for `OperationPlan.approvedBy` and `StoredReceipt.reviewedBy`, while a human actor is accepted without a cast.

