# P1: routing never consulted policy, so a denied capability was published as a native tool

Status: **RESOLVED**

Reviewed `origin/main` at `7993ee2` (PR #29). Resolved in PR #34.

## Finding

Policy was enforced at execution and nowhere earlier. `desiredNative` built
the native surface from `availableCapabilities` alone, and `findCapabilities`
ranked the whole application catalog; the only policy call on the routing
path was `decidePolicy`, used to set `requiresApproval` on a match. A
capability the policy denied outright was therefore ranked, listed in the
routing report with its name and description, activated, and registered
through `registerTool`, so `getTools()` published its name, description, and
input schema on either exposure. The agent learned of the denial only by
calling it.

Reproduction, with two READ capabilities sharing the intent `get order` and
this policy:

```ts
const policy = ({ capability }) =>
  capability.name === "delete_order"
    ? { kind: "deny", reason: "delete_order is denied" }
    : { kind: "allow" };
```

Registered tool names after `start()`, and after `routeTask("get order")` in
routed exposure, on `main` at `7993ee2`:

```text
flat   getTools(): delete_order, find_capabilities, get_action_status, get_context, get_order, invoke_capability  | delete_order present: true
routed getTools(): delete_order, find_capabilities, get_action_status, get_context, get_order, invoke_capability  | delete_order present: true
```

The same script at this head:

```text
flat   getTools(): find_capabilities, get_action_status, get_context, get_order, invoke_capability  | delete_order present: false
routed getTools(): find_capabilities, get_action_status, get_context, get_order, invoke_capability  | delete_order present: false
```

`docs/routing.md` described the runtime as ranking first and annotating with
availability, and said its behaviour was unchanged by the V2 `eligible`
predicate. That was accurate, and it was the defect: the runtime had no
eligibility predicate of its own, so the distinction the runtime was
supposed to keep, denied is invisible and unavailable is visible with a
reason, held only for the unavailable half.

## Required correction

One predicate that asks policy whether a capability may be offered at all,
evaluated ahead of ranking and ahead of registration, and shared by every
place the runtime names a capability to the agent. Denied means absent from
the routing report, from the native surface in both exposures, from the
routed working set, and from the `nowPossible` and `blockedCapabilities`
lists on every result. A capability invoked by name that this predicate
denies must answer `POLICY_DENIED` before its availability is read, so a
guessed name learns nothing about its state.

## Regression requirement

A policy that denies a subset of a catalog, asserting after `start()` in
flat exposure and after `find_capabilities` in routed exposure that no
denied name is registered, that the surface never exceeds the four bootstrap
tools plus `MAX_ROUTED`, and that the routing report and every refusal list
no denied name in any field. A deny-all case asserting every field empty on
every path, including the report text.

## Resolution

`routable` in `runtime.ts` is the one predicate. It asks policy with no
input, because routing has none, and a throwing policy denies.
`findCapabilities` filters the catalog through it before ranking,
`desiredNative` filters through it on both exposures before reconciling the
surface, `pruneRouted` drops a routed name it now denies, and `partition`
computes both lists on every result through it, so none of the four can
name a capability the others would not. `runCapability` checks it before
availability. Covered by `packages/webmcp/tests/result-protocol.test.ts`:
`never registers more than the bootstrap tools plus MAX_ROUTED, and never a
denied one` for the routed surface under a mixed policy, `registers no
native tool for a denied capability in flat exposure either` for flat, and
`every field of every result is empty and no name, description, or schema
leaks` for the deny-all case across the report and every invocation. All
three fail against `7993ee2`.
