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

A capability scoring zero is never routed. Ties break by name, so equal
scores never reorder between runs.

## Three strategies

`routeTask(candidates, request, strategy, eligible)` is the V2 entry point.
It is async, and it defaults to the deterministic scorer above.

**`deterministic`** is `rankCapabilities` in a structured envelope. Same
order, same scores.

**`hybrid`** adds three lexical and structural signals on top. It is not
semantic and this document will not call it that.

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

This differs from `find_capabilities` in the runtime, which ranks first and
then annotates each match with its availability, including the unavailable
ones and the reason. That is deliberate. Telling an agent why it cannot do
something is more useful than pretending the capability does not exist.
`routeTask` is the newer surface and takes the stricter position; the
runtime's behaviour is unchanged by this document.

## The visible-capability budget

`DEFAULT_ROUTED` is 5 and `MAX_ROUTED` is 6. Every strategy is capped at
`min(limit, MAX_ROUTED)`, including relationship pulls and custom scorers.
Nothing widens the surface. A graph edge can change which capabilities are
visible; it cannot change how many.

## Supplying your own scorer

```ts
const result = await routeTask(candidates, request, {
  kind: "custom",
  scorer: async (offered, { query }) => {
    const ranked = await myEmbeddingService.rank(query, offered);
    return ranked.map(({ capability, similarity }) => ({
      capability,
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
other than an array, returns an entry whose score is not finite, or returns
a capability it was not offered.

## Reading the result

```ts
type RoutingResult =
  | {
      ok: true;
      strategy: "deterministic" | "hybrid" | "custom";
      scoredExternally: boolean;
      degradedFrom?: RoutingStrategyKind;
      degradedBecause?: string;
      matches: readonly ScoredCapability[];
    }
  | { ok: false; strategy: "custom"; reason: string };
```

`strategy` is what actually ran, not what was asked for, so a custom request
that fell back reports `deterministic`. `scoredExternally` is true only when
a supplied scorer produced the ordering. Those two fields exist so no caller
can report semantic retrieval it did not perform.

Every match carries `reasons`, in the order the contributions applied, so
"why is this here" is answerable without re-running the scorer.

<!-- code-anchors
packages/webmcp/src/router.ts routeTask rankCapabilities RoutingStrategy CapabilityScorer RoutingResult RELATION_WEIGHTS ROUTING_WEIGHTS MAX_ROUTED DEFAULT_ROUTED scoredExternally degradedFrom
packages/webmcp/src/capability.ts CapabilityRelationships relationships
-->
