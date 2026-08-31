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

## Resolved

`defineCapability` copies and freezes both arrays and the containing object,
so mutating the array a caller passed in no longer rewrites the graph of an
already-defined capability. Reverting the copy reproduces the finding:
`expected [ 'first_step', 'smuggled_step' ] to deeply equal [ 'first_step' ]`.
