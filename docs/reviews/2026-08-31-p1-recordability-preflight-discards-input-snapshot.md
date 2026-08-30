# P1: recordability preflight discards the input snapshot

Status: **RESOLVED** in `bf079ca`

Reviewed branch: `fix/reset-epoch-and-approval-identity` at `fc4ae0a`

## Finding

`runExecution` calls `structuredClone(input)` before dispatch to prove the
input can be receipted, but discards that snapshot. The handler receives the
caller's original object, and receipt finalization clones that object again.
The claim therefore does not cover the value that is executed or recorded.

A getter-backed input returned a cloneable value during validation and the
preflight, then returned a function during receipt finalization. The handler
committed once, finalization returned an error, and no receipt was stored:

```json
{
  "writes": 1,
  "reads": 3,
  "isError": true,
  "receipts": 0,
  "terminal": ["execution_failed"]
}
```

This recreates the exact invariant the preflight was meant to close: a write
happened but the governance record says only that execution failed.

## Required correction

Own the input once at the public execution boundary, validate the owned
value, and pass that same owned value to the handler, verification, receipt,
and audit paths. Do not use a clone merely as a probe and then continue with
the caller-owned object.

## Regression requirement

Use a getter-backed input whose first reads are cloneable and whose later read
is not. Assert the handler either does not run, or runs against the owned
snapshot and produces one completed event plus one receipt. The failing
outcome above must be impossible.

## Resolution in `bf079ca`

The clone is now the input rather than a probe. `runExecution` takes the
caller's value as `caller`, owns it once, and binds the result to `input`, so
the handler, the verifier, the receipt entry, and the audit event all read the
same snapshot and nothing downstream can reach the original.

Reproduced first at two cloneable reads, which is the boundary case: three
reads, one write, no receipt, and a lone `execution_failed`. Both regression
tests are in
`packages/webmcp/tests/input-ownership-and-actor-shape.test.ts`. The second
is the sharper one, since an input answering a different order on every read
was receipted as `order-6` while the handler acted on `order-3`, and that
mismatch is silent rather than an error.
