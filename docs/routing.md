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

## 29.1% on a real-sized catalog

The scorer above was tuned on a seeded demo. Against a catalog it was not
seeded for, it publishes the capability a task needs less than a third of
the time. The routing stress evaluation in `docs/evaluations.md` generates
408 capabilities across twelve domains from seed 2026, with vocabulary
shared on purpose, and routes 55 held-out messy phrasings through
`routeTask` under both built-in strategies. The deterministic scorer routes
the expected capability into the published set of five for 29.1% of tasks,
16 of 55, and in 74.5% of tasks the fifth and sixth scores are equal, so
codepoint order of the name decides what is published. Hybrid does worse,
23.6%, because its `requires` edges pull the `get_*` prerequisite of every
matched write into the set and spend the budget on reads; the graph helps
when the base match is right and cannot repair one that is wrong. The
committed run is `scripts/evals/runs/routing-reference/`, and
`pnpm check:docs` holds the figures here to that run's `report.json`.
These are the numbers roadmap item 2.2 has to beat; the section below
reports its lexical step against them.

## 34.5% with a lexical domain step

`hierarchicalScorer` is the domain step of "Narrowing in two calls" run
with no client to choose the domain: the query's content tokens, folded to
forms the catalog's vocabulary contains, choose a domain by inverse
capability frequency, and the deterministic scorer runs inside with ties
at the cut reduced by description overlap. It ships single-domain:
`NEAR_TIE` is 1, so a second domain is kept only when it ties the top one
exactly, and `hierarchicalScorerWith({ nearTie })` builds the step at any
other share. Run through the same evaluation as a custom scorer,
`--scorer packages/webmcp/examples/hierarchical-scorer.mjs`, it routes the
expected capability into the published set for 34.5% of tasks, 19 of 55,
beside the reference's 29.1% for the deterministic cell of the same run,
with a tie at the cut in 52.7% of tasks against 74.5%. It gains 7 tasks
and loses 4. On the second held-out set, seed 7 and phrasings authored
after the step shipped, it routes 36.4% of tasks, 20 of 55, against the
deterministic scorer's 29.1%, with a tie at the cut in 52.7% of tasks
against 61.8%, gaining 6 and losing 2. The committed runs are
`scripts/evals/runs/routing-2.2-single/` and
`scripts/evals/runs/routing-holdout-2-single/`, held here by
`pnpm check:docs` the way the reference is.

The first measurement kept a second domain at a near tie of 0.75 and
scored 36.4% on the first set, one task more, at a tie rate of 61.8%;
the second held-out set showed the near tie earning nothing net, and
`docs/evaluations.md` holds that ablation with its runs. Single-domain is
what ships because it is what the two-call flow is, where a client
chooses one domain, and because a near tie that trades a task for nine
points of ties at the cut on one set and nothing on the other is not a
rule, it is a coincidence of one seed's vocabulary.

That is not a wide margin, and each set was measured once: the tasks are
held out and the scorer was not tuned against them. What moved is what a
domain step can move. The refund phrased around the customer lands
`refund_shipping_fee` under billing instead of five customer tools; proof
of a payment lands `get_receipt`; the month-end invoicing run lands
`create_invoice_batch`; the carrier switch lands `assign_carrier`. What
did not move cannot move lexically: "Send me the printable version of
INV-2291" shares no token with any domain and scores nothing anywhere,
and "put them together" is a merge only to a reader. The losses are
tasks the flat scorer found by a keyword the chosen domain does not
carry. The lexical step is the floor for the two-call flow, in which the
client reads the tree's descriptions and chooses the domain the way a
person would; that choice is what roadmap item 2.4 measures with
transcripts.

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

## Narrowing in two calls

A catalog of four hundred capabilities does not fit in one ranked answer,
and no model runs on the page to pick the right five. So `find_capabilities`
answers at two levels. Called with a `query` and no `domain`, it is the
single call it always was, ranked by the deterministic scorer over the
routable catalog, and it carries `domains` beside the matches: the
catalog's tree, each domain with a description drawn from its members'
vocabulary, a count, and its subdomains when it has more than one. Called
with `domain`, or `domain/subdomain`, it ranks inside that branch under
the same budget and the same `routable` predicate, so a denied capability
is absent from every level: not counted, not in a description, not ranked
when the query names it. An unknown domain routes nothing and answers with
the tree. A client that skips the first call loses nothing; a client that
reads the tree chooses the domain the way a person would, and that choice
is what removes the cross-domain collision the reference lists, the refund
phrased around the customer that routed five customer tools.

- **How a capability declares its subdomain.** `subdomain` beside
  `domain`; absent, it defaults from its domain. A domain lists
  subdomains only when its members declare more than one, so a flat
  catalog pays no bytes for a level it does not have. A capability with
  no domain lives under `uncategorized`.
- **How the tree is derived and cached.** `catalogHierarchy` is built
  once per runtime and tokenizes every capability's name, keywords,
  intents, and description at construction. A call pays the routable
  filter and a count, because policy is a function of the moment and
  cannot be cached; the tree is cached by the admitted set, so two calls
  that admit the same members share one object. A domain's description
  is the six keyword terms most concentrated in it, weighted by count
  squared over catalog-wide count, so "add" and "view", which every
  domain carries, describe none of them, and a denied capability's words
  leave the description when it leaves the count.
- **What the report carries.** `RoutingReport.domain` when the call
  narrowed, and `RoutingReport.domains` when it returned the tree, so the
  demo's Inspector can show what the client was choosing from.
- **The byte bound.** A first-level answer's `domains` serializes below
  the bootstrap surface's own schema bytes on a catalog the stress
  evaluation's size, twelve domains of thirty-four; a test holds it there.
  The bootstrap surface itself does not change: `domain` is accepted by
  `find_capabilities` and not declared in its schema, because those bytes
  are the budget every published set is measured against and the figure
  the task evaluation's reference records. The narrowing input is
  announced in every first-level answer's `instruction`, beside the
  `domains` it applies to, so a client that reads the tree can use it and
  a client that reads only schemas sees the surface it always saw.
- **How ties at the cut are reduced.** Inside a branch the deterministic
  scorer runs as it does everywhere, and every content word the query
  shares with a capability's title, name, or description adds 0.05,
  capped at eight words, so the bump decides among capabilities the
  scorer could not tell apart and never outranks a signal it found. The
  context domain already weighs 4 in that scorer, so a tie between
  domains breaks on it before the name with no further rule. A capability
  the scorer gave nothing can rank on the bump alone inside a branch,
  because the domain step already established the query is about it.

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
packages/webmcp/src/hierarchy.ts catalogHierarchy hierarchicalScorer hierarchicalScorerWith rankWithin baseScore CatalogTree CatalogDomain UNCATEGORIZED NEAR_TIE OVERLAP_WEIGHT OVERLAP_CAP DESCRIPTION_TERMS
packages/webmcp/src/capability.ts subdomain
-->
