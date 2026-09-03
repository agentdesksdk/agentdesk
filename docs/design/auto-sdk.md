# AgentDesk Auto, design

Status: design only. Nothing here is implemented.

Goal. A team with an existing application runs two commands and gets a
governed WebMCP surface, without rewriting business logic as capabilities.

```bash
npm install @agentdesksdk/auto
npx agentdesk init
```

`defineCapability` stops being the onboarding mechanism and becomes the
escape hatch.

## What already holds

Two things make this smaller than it looks, and one thing that an earlier
draft counted as free is not.

`Capability.execute` is an arbitrary function. Nothing in the pipeline
assumes the executor is application code, so a generated executor that
issues `fetch("/api/orders/:id/refund")` is indistinguishable from a
hand-written one.

The catalog-to-surface reduction already exists. Auto only has to produce
the catalog; routing, availability, policy, approval, and audit are
untouched.

## What does not already hold

The `@agentdesksdk/core` extraction is real refactoring. The adapter is
referenced in only four files under `packages/webmcp/src`, which is what
an earlier draft read as a rename with an entry point attached. The count
is right and the conclusion was wrong. `createAgentDeskRuntime`
constructs the concrete WebMCP adapter as its own default and then
constructs the tool surface around it, so the provider role is wired in
by construction. A caller may override it, but nothing in the type system
says the runtime is provider-agnostic, and nothing stops the next change
from reaching for WebMCP specifics inside the core.

Define the boundary before moving files.

```ts
type CapabilityProvider = {
  readonly kind: "webmcp" | "extension";
  readonly supported: boolean;
  start(surface: ToolSurface): Promise<void>;
  stop(): Promise<void>;
};
```

Auto and the extension both depend on this landing first. It has: the
runtime takes a `CapabilityProvider` from `packages/webmcp/src/provider.ts`
and builds no adapter of its own, with the shape narrowed to what a
provider supplies, `capabilities()`, `adapter`, and an optional
`subscribe`, rather than the `start`/`stop` sketched above, since the
surface stays the runtime's. `docs/architecture.md` states the seam.

<!-- code-anchors
packages/webmcp/src/provider.ts CapabilityProvider nativeProvider
packages/webmcp/src/runtime.ts ToolSurfaceManager provider
packages/webmcp/src/policy.ts riskBasedPolicy decidePolicy
packages/webmcp/src/capability.ts approvalEvidence previewChanges defineCapability
-->


## The data shape: a capability manifest

Everything upstream converges on one artifact. The manifest is not a
`Capability`, and an earlier draft implied it could feed the runtime
unchanged. It cannot. `defineCapability` rejects a CONSEQUENTIAL
capability that has neither `previewChanges` nor an explicit
`approvalEvidence: "summary"`, on the grounds that approving without a
diff has to be a deliberate choice. A generated entry has no
`previewChanges` function and no opinion about evidence, so handing the
manifest straight to the runtime throws.

So there are two shapes and a compiler between them.

```text
CapabilityManifestEntry
  -> compileManifestEntry(entry, adapter, policy)
  -> validated Capability
  -> AgentDesk runtime
```

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

type CapabilityManifestEntry = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  mutability: "read" | "write";
  consequence: "routine" | "consequential" | "unknown";
  domain?: string;
  source: CapabilitySource;
  provenance: CapabilityProvenance;
  /** Where it came from, for `agentdesk inspect` and for blame. */
  origin: { file?: string; symbol?: string; route?: string; method?: string };
  /** Set when the compiler could not determine something itself. */
  inferred: Array<"name" | "description" | "consequence" | "schema">;
  /** How a human approves this, since nothing generated can preview itself. */
  approvalEvidence?: "diff" | "summary";
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

### What the compiler adds, and what it refuses

`compileManifestEntry` is the boundary between generated data and the
runtime's typed model, so it is where validation lives and the only place
that knows about both shapes.

It supplies `execute` by closing over the executor and the adapter, and
`readOnlyHint` from `mutability === "read"`. It sets
`untrustedContentHint` unconditionally, because every field in a
generated entry came from a specification or a page that AgentDesk does
not control. It derives `RiskLevel` from the two axes below.

It refuses an entry that would produce an unapprovable capability. A
`consequential` entry with no `approvalEvidence` is a compile error naming
the entry and the two ways to resolve it, rather than a runtime throw
during `init` with a stack trace pointing into the SDK. The check exists
in the runtime already; the compiler's job is to fail earlier and in the
developer's own terms.

Nothing in the compiler downgrades risk. Overrides do that, and they are
config the developer wrote.

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

| `semanticProvenance` | Sources | Default treatment |
| --- | --- | --- |
| `declared` | `explicit`, `webmcp` | Risk as declared |
| `contract` | `openapi`, `graphql`, `trpc` | Read-only when the contract says so, otherwise CONSEQUENTIAL |
| `structural` | `server-action`, `route` | CONSEQUENTIAL unless the route is declared read-only |
| `observed` | `form`, `dom` | CONSEQUENTIAL, never auto-approved |

The tier is discrete, checkable, and explains itself in a review. A
capability moves tiers by getting better metadata, not by someone editing
a number.

This tier is one dimension of four, and treating it as the whole of trust
is what let an earlier draft call native WebMCP "highest trust" without
qualification. A site's own declaration is authoritative about the site's
mechanics and says nothing about whether its strings are safe to put in a
model's context.

```ts
type CapabilityProvenance = {
  sourceKind: "native" | "declarative" | "inferred" | "authored";
  semanticProvenance: "declared" | "contract" | "structural" | "observed";
  executionOwnership: "agentdesk" | "page" | "browser";
  contentTrust: "untrusted";
};
```

`contentTrust` has one value because descriptions and results are
attacker-influenced on every source, including `explicit`, once a field
in them is user-supplied. The runtime carries this as
`untrustedContentHint`, and the compiler sets it on everything it
generates. `docs/design/browser-extension.md` uses the same four
dimensions, and they mean the same thing on both sides.

## Risk inference and its escape hatch

An earlier draft mapped `POST`, `PUT`, and `PATCH` to `WRITE`, and that is
unsafe against this runtime. `WRITE` is not a gate here. `defineCapability`
gives a non-CONSEQUENTIAL capability `{ kind: "allow" }`, and
`riskBasedPolicy` requires approval only when the policy says
`approval_required`. `WRITE` executes and audits. It does not stop for a
human. So a refund reachable at `POST /orders/:id/refund` would be
generated, classified `WRITE`, and run unapproved. That is the whole bug,
and it comes from one enum carrying two different questions.

Split them.

| Axis | Values | Question |
| --- | --- | --- |
| `mutability` | `read`, `write` | Does this change state? |
| `consequence` | `routine`, `consequential`, `unknown` | Does a human need to see it first? |

An HTTP verb answers the first and is silent on the second. `POST
/search` and `POST /orders/:id/refund` are the same verb.

The defaults follow from that, and they are deliberately pessimistic.

- A clearly declared read-only operation is `READ`. Clearly declared means
  the source said so, such as an OpenAPI `get` or a GraphQL `query`, not
  that a name looked harmless.
- Any mutation is CONSEQUENTIAL. Not `WRITE`, because `WRITE` does not
  stop.
- `unknown` is CONSEQUENTIAL, so an unclassifiable operation fails toward
  the human.

Chrome's WebMCP security guidance takes the same position from the other
direction, treating a tool as state-changing unless `readOnlyHint` says
otherwise. The compiler sets `readOnlyHint` only on the first case above.

Downgrading is a separate act with an author. A developer override, or
authoritative metadata such as an explicit `readOnlyHint` in the source
specification, can move an operation from CONSEQUENTIAL to WRITE or READ.
Inference never downgrades on its own, so the diff that made a refund
auto-executable is always attributable to a line someone wrote.

This costs approval prompts on routine writes, and that cost is the point
during onboarding. `agentdesk inspect` lists exactly which operations are
CONSEQUENTIAL by inference rather than by declaration, which is the list
a team walks once and downgrades deliberately.

Name-pattern policy is config, evaluated after inference:

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

CAPABILITY          SOURCE         TIER        MUTABILITY  CONSEQUENCE    INFERRED
get_customer        openapi        contract    read        routine        -
create_order        openapi        contract    write       consequential  consequence
refund_order        openapi        contract    write       consequential  consequence
export_report       route          structural  write       unknown        name, consequence
pay_invoice         form           observed    write       consequential  name, consequence, schema
```

The `INFERRED` column is the point. It tells a reviewer exactly which
fields were guessed, so the review is bounded to those rather than being
an invitation to re-read everything.

Read the table as a work list. Every row whose `CONSEQUENCE` was inferred
rather than declared is a prompt a human will see until someone says what
the operation actually does. `create_order` is the ordinary case, a
routine write that will be downgraded on the first pass.
`export_report` is the interesting one, a route the compiler could not
classify at all, and `unknown` is the compiler admitting that rather than
guessing `read` because the name starts with `export`.

## Scope I would cut

The proposal lists eleven packages. For a project this size that is a
maintenance surface that will rot faster than it ships.

Start with exactly one discovery adapter, OpenAPI, because it is the
highest-quality source, requires no framework coupling, and proves the
manifest contract end to end. Add `@agentdesksdk/next` second only if the
manifest survived contact with a real spec. Every further adapter is the
same shape, so the second one is evidence the abstraction is right and the
eleventh is evidence nobody is maintaining it.

`@agentdesksdk/react`, `vue`, `svelte`, `angular` should not exist until
someone asks. The runtime is already framework-free and the demo proves a
React app needs no adapter to consume it.

## The limit, stated plainly

A compiler cannot recover business meaning that never entered the
metadata. `processThing(id)` that reverses a ledger entry, recalculates a
balance, and releases a fraud hold will be classified from its route and
its name, both of which are lies. Auto will produce a capability named
`process_thing`, marked `write` and `consequential`, with no idea what it
consequentially does.

That is the honest boundary, and it is why the explicit API survives.
Auto's job is to get a team from zero to a governed surface in an
afternoon and show them precisely which capabilities need a human to say
what they actually mean.

The defaults are chosen so that this limit is loud rather than silent.
`process_thing` compiles to a CONSEQUENTIAL capability that stops for a
human on every call, and it stays that way until someone who knows what
it does writes an override. The failure mode is an annoying prompt, not a
reversed ledger entry.
