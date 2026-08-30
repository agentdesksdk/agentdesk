# P1: approval rejects a valid actor without an optional name

Status: **RESOLVED** in `bf079ca`

Reviewed branch: `fix/reset-epoch-and-approval-identity` at `fc4ae0a`

## Finding

`Actor.name` is optional, but `normalizeActor` rejects every identity whose
`name` is not a string. A valid human actor such as
`{ id: "human-1", kind: "human" }` is therefore refused at the approval
boundary with:

```text
an approval must name an identity with an id, a name, and a kind the runtime can copy
```

This is a runtime contract regression hidden by tests that always provide a
name. PR #8 already has the canonical `parseActor` boundary, which accepts a
missing name and rejects a present non-string name.

## Required correction

After PR #8 lands, delete this branch's duplicate actor parser and use the
canonical ownership and parsing path. If fixed before that rebase, treat a
missing name as valid and only reject a present malformed name.

## Regression requirement

Approve and reject with `{ id: "human-1", kind: "human" }` and assert both
paths accept and record the actor. Keep the existing malformed-name refusal.

## Resolution in `3e7cd44`

`normalizeActor` treats a missing name as valid and refuses only a present
name of the wrong type. `approve` and `reject` both accept
`{ id: "human-1", kind: "human" }` and record it, and the malformed-name
refusal is unchanged. All three are regression tests.

This is the interim fix the finding allows for. The duplicate parser on this
branch is still slated for deletion in favour of the canonical `parseActor`
once #8 lands, which is the correction the finding actually asks for.

## Note on the correction that was asked for

The finding asked for the duplicate parser to be deleted in favour of the
canonical path once #8 landed. That is what happened. This branch was rebuilt
on `dd60ec4` rather than merged into it, `normalizeActor` does not exist, and
`approve` and `reject` call the same `resolveHumanActor` that `approvePlan`
and `markReviewed` use. The optional-name behaviour is `parseActor`'s, not a
second opinion about it.
