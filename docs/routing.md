# Routing

AgentDesk publishes a small subset of a large capability catalog. Routing
decides which subset. This document covers what the router does, what it
deliberately does not do, and how to replace its scoring.

`docs/architecture.md` covers the surrounding pipeline. This is only the
scoring step.

## The default has not changed

`rankCapabilities(capabilities, ctx, query, limit)` is the scorer that
shipped, and it is still what runs when nobody asks for anything else. Its
weights, its tie-breaking, and its budget are unchanged.

| Signal | Weight | Matches when |
| --- | --- | --- |
| Intent | 5 | Every word of a declared intent phrase appears in the query |
| Domain | 4 | The domain is named in the query, or is the context domain |
| Entity | 3 | A declared entity key is present in context state |
| Keyword | 2 per hit, capped at 2 hits | A declared keyword appears in the query |
| Route | 1 | The current route starts with a declared prefix |

A capability scoring zero is never routed. Ties break by codepoint order of
the name, so equal scores never reorder between runs or between hosts. The
comparison is deliberately not locale-aware. A locale-aware tie-break resolves
against the user's locale in a browser, and Danish collation sorts a leading
`aa` after `z`, so the same application published a different tool set to a
Danish user than to an English one.

## Three strategies

`routeTask(candidates, request, strategy, eligible)` is the V2 entry point.
It is async, and it defaults to the deterministic scorer above.

**`deterministic`** is `rankCapabilities` in a structured envelope. Same
order, same scores.

**`hybrid`** adds three lexical and structural signals on top. It is not
semantic and this document will not call it that.

It scores the whole eligible pool before trimming, not the deterministic top
six. Trimming first would discard the base score of a capability ranked
seventh, so its relationship bonus would start from zero and it would lose
to capabilities it should beat.

| Signal | Weight | Matches when |
| --- | --- | --- |
| Exact term | 6 | The query names the capability, by name or title |
| Requires | 3 | A higher-scoring match declares it in `requires` |
| Related | 1 | A higher-scoring match declares it in `related` |
| Session | 2 | The name appears in `request.session` |

**`custom`** hands scoring to a `CapabilityScorer` you supply.

## The capability graph

A capability declares what it sits next to.

```ts
defineCapability({
  name: "refund_shipping",
  relationships: {
    requires: ["verify_payment_captured"],
    related: ["issue_credit"],
  },
  // ...
});
```

`requires` is what usually has to happen first. `related` is what a caller
commonly wants alongside. Both are names, not references, so a capability
may name one the catalog does not hold and routing simply ignores it rather
than throwing.

These are routing hints and nothing more. The runtime does not enforce
ordering from `requires`, because a capability that genuinely cannot run yet
refuses through `availability` or `checkInput`, where the refusal carries a
reason a human can read. A graph edge carries no reason, so it is the wrong
place to express a precondition.

The walk is one hop. A prerequisite of a prerequisite is a catalog dump
wearing a graph costume, and the point of routing is to publish less.

## What is filtered, and when

`eligible` is a predicate the caller supplies, and it runs before any
scoring. It exists so availability and policy filtering happen ahead of
ranking rather than after it.

The router does not import availability or policy itself. A scorer that
cannot read application state is far easier to reason about than one that
can, and a custom scorer receives only what survived the filter, so it
cannot resurrect something the runtime already declined to offer. A scorer
that returns a capability it was not given is refused rather than trusted.

`find_capabilities` in the runtime applies the same idea with one predicate
of its own, `routable`, which asks policy with no input because routing has
none. A capability policy denies is filtered out before ranking, so it is
absent from the report: not its name, not its description, not a reason.
A capability that is merely unavailable is ranked, annotated with its
`reasonCode` and `reason`, and not activated. That split is deliberate.
Telling an agent why it cannot do something is more useful than pretending
the capability does not exist, and pretending a denied capability does not
exist is the point of denying it.

The same predicate decides what the native surface registers and what
every result lists as possible or blocked, so the report, the tools, and
the answers on a refusal can never disagree about what the agent may reach.
`docs/architecture.md` covers the result side.

## The report's situation

The routing report answers the same questions every other result does.
`nowPossible` and `blockedCapabilities` are the matches it offered plus the
repairs those matches named, partitioned by availability through
`routable`; `evidence` is empty, because routing proves nothing. Each
unavailable match carries its author's `repair` only when the runtime
checked that the named capability exists, is routable, and is available,
with `suggestedCapability` derived from it for readers of the old name. A
repair naming a denied capability is dropped from the match and from the
lists, so a routing report leaks no more than a refusal does.

## The visible-capability budget

`DEFAULT_ROUTED` is 5 and `MAX_ROUTED` is 6. Every strategy is capped,
including relationship pulls and custom scorers.

The cap is `max(0, min(floor(limit), MAX_ROUTED))`, and a non-finite limit
falls back to the default. A plain `min` was wrong: a negative limit reached
`slice(0, -1)`, which drops one entry and returns the rest, so `limit: -1`
published almost the whole catalog.

Nothing widens the surface. A graph edge can change which capabilities are
visible; it cannot change how many.

## Supplying your own scorer

```ts
const result = await routeTask(candidates, request, {
  kind: "custom",
  scorer: async (offered, { query }) => {
    const ranked = await myEmbeddingService.rank(query, offered);
    return ranked.map(({ name, similarity }) => ({
      name,
      score: similarity,
      reasons: ["embedding"],
    }));
  },
  onFailure: "deterministic",
});
```

The interface is async so an embedding model can be connected later without
changing this contract.

`onFailure` decides what a broken scorer produces. `deterministic` degrades
to the built-in scorer and records `degradedFrom` and `degradedBecause`.
`refuse` returns `{ ok: false, reason }`. There is no third option where a
failed scorer quietly returns nothing, because an empty result and a failed
scorer are different facts and a caller has to be able to tell them apart.

A scorer is treated as failed when it throws or rejects, returns anything
other than an array, returns an entry whose score is not finite, returns a
capability it was not offered, or returns the same capability twice. A
duplicate is refused rather than deduplicated, because it would otherwise
spend the budget on one capability.

The scorer never sees a `Capability`. It receives `RoutingDescriptor`
objects, which carry the name, description, risk, and routing metadata and
none of the functions. Freezing an array of capabilities was not enough,
because the objects inside it were the live ones and a scorer could replace
a handler on something it was merely scoring.

It answers with names, not objects, so there is nothing to forge. Accepted
names map back to the capability that was offered under that name.

The call and the parse share one guard, because reading `score` can invoke a
getter and a getter that throws outside the guard escapes as a raw rejection
from a method whose type promises a structured refusal.

The request is a `RoutingRequestSnapshot`, not the `RoutingRequest` the
caller passed. It is owned, flat, and value-free. Passing the request
through handed over `context`, `context.state`, and `session` by reference,
and a shallow freeze sealed only the wrapper, so a scorer could write to
application state and to the caller array.

`contextKeys` names which state keys are set and never what they hold.
Routing only asks whether an entity is present, and a scorer is the
component most likely to become a network call later, so the values have no
business crossing that line. A customer email in `state` is not something an
embedding service should receive because a capability declared an entity.

`reasons` is optional. Absent means no explanation was given and defaults.
Present but not an array of strings is a refusal, because substituting a
plausible reason would put words in the scorer mouth in the one field whose
job is explaining a decision.

A score of zero or below means not selected, matching the deterministic
scorer, so a similarity of zero drops the capability rather than routing it
at the bottom.

## Reading the result

```ts
type RoutingResult =
  | { ok: true; strategy: "custom"; scoredExternally: true; matches: Matches }
  | {
      ok: true;
      strategy: "deterministic" | "hybrid";
      scoredExternally: false;
      matches: Matches;
    }
  | {
      ok: true;
      strategy: "deterministic";
      scoredExternally: false;
      degradedFrom: "custom";
      degradedBecause: string;
      matches: Matches;
    }
  | { ok: false; strategy: "custom"; reason: string };
```

`strategy` is what actually ran, not what was asked for, so a custom request
that fell back reports `deterministic`. `scoredExternally` is true only when
a supplied scorer produced the ordering. Those two fields exist so no caller
can report semantic retrieval it did not perform.

The variants are spelled out rather than collapsed into optional fields,
because the combinations that cannot happen should not be constructible. A
single loose shape allowed `strategy: "custom"` with
`scoredExternally: false`, which is a claim about provenance that no run can
produce. Reading `degradedBecause` now requires narrowing to the degraded
variant first.

Every match carries `reasons`, in the order the contributions applied, so
"why is this here" is answerable without re-running the scorer.

<!-- code-anchors
packages/webmcp/src/router.ts routeTask rankCapabilities RoutingStrategy CapabilityScorer RoutingResult RELATION_WEIGHTS ROUTING_WEIGHTS MAX_ROUTED DEFAULT_ROUTED scoredExternally degradedFrom
packages/webmcp/src/capability.ts CapabilityRelationships relationships
packages/webmcp/src/runtime.ts routable partition visibleRepair findCapabilities
-->
