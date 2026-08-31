# P2: normalized routing relationships retain mutable aliases

Status: **OPEN**

Reviewed worktree: `crisp-grove`, commit `efb5553` (PR #12)

## Finding

`defineCapability` materializes both relationship fields but stores the
caller's arrays by reference. A JavaScript caller can mutate the source array
after definition and silently change the capability graph. This was reproduced
by pushing a second prerequisite into the original array and observing it
appear on the already-defined capability.

The public `CapabilityRelationships` type also keeps both fields optional even
though normalized `Capability` values always contain them. That forces router
code to defend against a state the constructor says it removes.

Affected code: `packages/webmcp/src/capability.ts:80-83`,
`packages/webmcp/src/capability.ts:154`, and
`packages/webmcp/src/capability.ts:471-474`.

## Required correction

Separate the optional author input shape from the normalized capability shape.
Copy relationship arrays during definition, and make both fields required on
the normalized `Capability` type. Follow the repository's existing ownership
and immutability conventions if they require freezing as well as detaching.

## Regression requirement

Mutate each source array after `defineCapability` and prove the normalized
capability is unchanged. Add compile-time checks that normalized relationships
do not require optional defaults at use sites.

## Attempted resolution at `0887a62`

`defineCapability` copies and freezes both arrays and the containing object,
so mutating the array a caller passed in no longer rewrites the graph of an
already-defined capability. Reverting the copy reproduces the finding:
`expected [ 'first_step', 'smuggled_step' ] to deeply equal [ 'first_step' ]`.

## Follow-up verification

The runtime alias is fixed, but the type half of the finding remains open.
`CapabilityRelationships` still declares `requires` and `related` optional and
the normalized `Capability.relationships` still uses that input type. Router
code consequently keeps `const { requires = [], related = [] }`, defending
against a state `defineCapability` always removes. Split the optional author
input from the normalized required output and add the requested compile-time
regression before closing this record.

## Reopened, then resolved properly

The runtime half was fixed and the type half was not, and I reported both as
done. `CapabilityRelationships` kept `requires?` and `related?` optional on
the normalized `Capability`, so every reader still had to guard for
`undefined` on fields that are always present after `defineCapability`.

Author input and normalized output are separate types now.
`CapabilityRelationships` stays optional, because making an author write two
empty arrays to say nothing would be a worse API.
`NormalizedRelationships` has both as required and readonly, and that is
what `Capability.relationships` carries.

The compile-time regression reads `capability.relationships.requires` into a
`readonly string[]` with no `??` and no `?.`, which does not typecheck while
the fields are optional under `exactOptionalPropertyTypes`.
