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

## Follow-up verification

The named array, null, and scalar cases are fixed, but the broader boundary
claim is not. `RegisteredTool.inputSchema` uses the TypeScript `object` type,
so values such as `Date`, `Map`, and `RegExp` are legal inputs to the helper.
The shared check still accepts all of them even though none is a JSON Schema
object. A `Date` also proves that the two encodings still disagree:

```text
readInputSchema({ name: "date_schema", inputSchema: new Date(...) })
=> { ok: true, schema: Date }

readInputSchema({ name: "date_schema", inputSchema: JSON.stringify(new Date(...)) })
=> { ok: false, reason: "...not a JSON object" }
```

This was reproduced from the built package at `7cec551`. The current check
proves only non-null, non-array JavaScript object, not a plain JSON object.
Keep the record open until the direct arm rejects non-JSON object kinds and a
regression covers at least `Date`. The check must preserve legitimate plain
objects arriving from another window rather than relying on same-realm
prototype identity.

## Resolution, second pass

`typeof value === "object"` also admits `Date`, `Map`, `Set`, `RegExp`, and
`Error`, so the direct arm accepted them while a `Date` serialized to a JSON
string and was refused. Both arms are now judged by `isPlainJsonObject`, which
compares the internal class tag rather than a prototype.

The tag survives a realm boundary, so a plain object built in another window
is still accepted, which `instanceof Object` or a `=== Object.prototype`
comparison would have broken. A null-prototype object reports
`[object Object]` too and stays accepted.

Covered by `packages/webmcp/tests/mcp-b-schema-kinds.test.ts`, which builds a
cross-realm plain object through an iframe. Six of its cases fail against the
previous implementation.

One correction to the first draft of that suite. It asserted that a `Map`
must be refused "the same way once serialized", which is wrong: a `Map`
serializes to `{}`, a legal empty schema, so the two arms are being handed
different values. The suite now pins the genuine asymmetry, which is `Date`,
and separately asserts that `{}` remains accepted.
