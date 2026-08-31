# P2: routing result types allow false scorer provenance

Status: **OPEN**

Reviewed worktree: `crisp-grove`, commit `efb5553` (PR #12)

## Finding

`RoutingResult` describes provenance with independent broad fields. The type
allows states the implementation says must be impossible, including
`strategy: "custom"` with `scoredExternally: false`, deterministic results with
`scoredExternally: true`, and degradation metadata on a normal success. That
weakens the stated guarantee that callers can tell what actually produced an
ordering.

Affected code: `packages/webmcp/src/router.ts:187-199`.

## Required correction

Encode success as a discriminated union whose deterministic, hybrid, custom,
and degraded variants carry only their valid fields. Custom success must imply
external scoring; ordinary built-in success must imply the opposite; only the
degraded variant may carry degradation metadata.

## Regression requirement

Add `@ts-expect-error` probes for each impossible combination and verify they
discriminate by widening the union back to the current shape. Keep runtime
tests for the reported strategy on successful custom scoring and fallback.

## Resolved

`RoutingResult` is four explicit variants instead of one shape with optional
fields. Custom is `scoredExternally: true` by construction, the built-in
strategies are `false`, and only the degraded variant carries `degradedFrom`
and `degradedBecause`.

The compile-time regression uses `@ts-expect-error` in
`packages/webmcp/tests/router-v2.test.ts`. It caught a real reader on the
first run: the existing degrade test read `degradedBecause` without
narrowing and stopped typechecking, which is the type doing its job rather
than a test to loosen.
