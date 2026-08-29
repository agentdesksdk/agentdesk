# AgentDesk Auto, design

Status: design only. Nothing here is implemented.

Goal. A team with an existing application runs two commands and gets a
governed WebMCP surface, without rewriting business logic as capabilities.

```bash
npm install @agentdesk/auto
npx agentdesk init
```

`defineCapability` stops being the onboarding mechanism and becomes the
escape hatch.

## What already holds

Three things make this smaller than it looks.

The runtime takes an injectable `adapter`, and only four files in
`packages/webmcp/src` reference it. The core is already separable from the
WebMCP provider role by construction, so the proposed `@agentdesk/core`
extraction is mostly a rename plus an entry point, not a rewrite.

`Capability.execute` is an arbitrary function. Nothing in the pipeline
assumes the executor is application code, so a generated executor that
issues `fetch("/api/orders/:id/refund")` is indistinguishable from a
hand-written one.

The catalog-to-surface reduction already exists. Auto only has to produce
the catalog; routing, availability, policy, approval, and audit are
untouched.

## The data shape: a capability manifest

Everything upstream converges on one artifact, and the runtime is the only
consumer.

```ts
type CapabilitySource =
  | "explicit"      // defineCapability in app source
  | "webmcp"        // already registered on document.modelContext
  | "openapi"
  | "graphql"
  | "trpc"
  | "server-action"
  | "route"
  | "form"
  | "dom";

type ManifestEntry = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  risk: RiskLevel;
  domain?: string;
  source: CapabilitySource;
  /** Where it came from, for `agentdesk inspect` and for blame. */
  origin: { file?: string; symbol?: string; route?: string; method?: string };
  /** Set when the compiler could not determine something itself. */
  inferred: Array<"name" | "description" | "risk" | "schema">;
  executor:
    | { kind: "http"; method: string; path: string }
    | { kind: "graphql"; operation: string; field: string }
    | { kind: "trpc"; procedure: string }
    | { kind: "form"; selector: string }
    | { kind: "module"; import: string; export: string };
};
```

`inferred` is deliberately a list of what was guessed, not a confidence
float. See the pushback below.

## Provenance tiers, not confidence scores

The proposal assigns numbers (OpenAPI .98, DOM inference .71) and gates
policy on thresholds. I would not ship that.

A float implies calibration nobody has measured. `0.71` is not a
probability of anything; it is a vibe rendered as a number, and once a
threshold consumes it (`>= 0.90 → execute`) the vibe is doing security
work. It also invites tuning the number to unblock a case rather than
fixing the inference.

Use ordered tiers, and let each tier carry a *policy default* rather than
a score:

| Tier | Sources | Default treatment |
| --- | --- | --- |
| Declared | `explicit`, `webmcp` | Risk as declared |
| Contract | `openapi`, `graphql`, `trpc` | Risk from the contract's own verb or operation type |
| Structural | `server-action`, `route` | Risk from method mapping, writes require approval |
| Observed | `form`, `dom` | Consequential by default, never auto-approved |

The tier is discrete, checkable, and explains itself in a review. A
capability moves tiers by getting better metadata, not by someone editing
a number.

## Risk inference and its escape hatch

Verb mapping is a reasonable default. `GET` reads, `POST`/`PUT`/`PATCH`
write, `DELETE` is consequential. Contract sources refine it: a GraphQL
query is READ, a mutation is WRITE.

Two rules keep the default honest. Anything the compiler could not
classify is CONSEQUENTIAL, not READ, so an unknown fails toward the human.
And name-pattern policy is config, evaluated after inference:

```ts
export default defineAgentDesk({
  discover: { openapi: true, routes: true, forms: false },
  risk: {
    "*refund*": "CONSEQUENTIAL",
    "*delete*": "CONSEQUENTIAL",
    "search_*": "READ",
  },
  overrides: {
    refund_order: { approvalEvidence: "diff", approval: "required" },
  },
});
```

Developers configure semantics. They never rewrite execution.

## What `agentdesk init` may and may not touch

`npm install` alone must not make browser code run, and a `postinstall`
that edits `next.config.ts` is disqualifying for a package whose job is
authorizing agent actions. `init` is the consent boundary.

`init` detects the framework, writes one config entry, generates the
manifest, and prints the diff before applying it. It refuses to run
non-interactively without `--yes`, and it never edits application source
outside the config file it owns.

## Review is the product, not a nicety

```text
npx agentdesk inspect

CAPABILITY          SOURCE         TIER        RISK           INFERRED
get_customer        openapi        contract    READ           -
create_order        openapi        contract    WRITE          -
refund_order        openapi        contract    CONSEQUENTIAL  risk
export_report       route          structural  READ           name, risk
pay_invoice         form           observed    CONSEQUENTIAL  name, risk, schema
```

The `INFERRED` column is the point. It tells a reviewer exactly which
fields were guessed, so the review is bounded to those rather than being
an invitation to re-read everything.

## Scope I would cut

The proposal lists eleven packages. For a project this size that is a
maintenance surface that will rot faster than it ships.

Start with exactly one discovery adapter, OpenAPI, because it is the
highest-quality source, requires no framework coupling, and proves the
manifest contract end to end. Add `@agentdesk/next` second only if the
manifest survived contact with a real spec. Every further adapter is the
same shape, so the second one is evidence the abstraction is right and the
eleventh is evidence nobody is maintaining it.

`@agentdesk/react`, `vue`, `svelte`, `angular` should not exist until
someone asks. The runtime is already framework-free and the demo proves a
React app needs no adapter to consume it.

## The limit, stated plainly

A compiler cannot recover business meaning that never entered the
metadata. `processThing(id)` that reverses a ledger entry, recalculates a
balance, and releases a fraud hold will be classified from its route and
its name, both of which are lies. Auto will produce a WRITE named
`process_thing`.

That is the honest boundary, and it is why the explicit API survives.
Auto's job is to get a team from zero to a governed surface in an
afternoon and show them precisely which capabilities need a human to say
what they actually mean.
