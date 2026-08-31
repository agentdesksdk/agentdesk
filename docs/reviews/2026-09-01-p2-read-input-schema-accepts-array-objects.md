# P2: the object schema arm accepts arrays and erases null

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `a0c5f23` (PR #13)

## Finding

`readInputSchema` validates the two compatibility arms differently. A schema
arriving as a string is parsed and rejected when it is null or an array, but a
schema arriving as an object returns immediately. Since arrays satisfy
`typeof value === "object"`, the object arm accepts `[]` as a JSON Schema
object. The function also treats an explicit `null` as if the member were
absent, although only `undefined` represents omission in its public contract.

This is observable from the built package:

```text
readInputSchema({ name: "array_schema", inputSchema: [] })
=> { ok: true, schema: [] }
```

The helper is the boundary that should normalize inconsistent browser
generations into one safe result. Returning malformed direct values while
refusing their serialized equivalents makes validity depend on transport
encoding.

Affected code: `packages/webmcp/src/client.ts:227-233` and
`packages/webmcp/src/client.ts:249-255`.

## Required correction

Parse only the string arm, then run both arms through one shared JSON-object
check. Treat only `undefined` as absent. Refuse null, arrays, and other values
that are not JSON Schema objects with a structured reason naming the tool.

## Regression requirement

Add paired tests proving that an array is refused in both direct-object and
serialized-string form, and that an explicit runtime `null` is refused while
an omitted member remains `{ ok: true, schema: undefined }`.

## Resolution

`readInputSchema` parses only the string arm and then judges both arms with
one check. An array, an explicit `null`, and a scalar are refused whichever
encoding they arrive in, with a reason naming the tool. Only an omitted member
is absence, so a `null` the browser actually sent is no longer read as
omission.

Covered by `packages/webmcp/tests/mcp-b-schema.test.ts`, which asserts the
direct and serialized forms of the same value get the same verdict. Three of
its cases fail against the previous implementation.
