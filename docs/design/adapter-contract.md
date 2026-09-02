# The adapter contract

Status: design only. Nothing here is implemented.

An adapter turns one kind of application metadata into governed
capabilities. OpenAPI is the first. A third party writing the second
should need this document and nothing else.

Read `auto-sdk.md` first. This specifies the interface that document
assumes, and it exists because "generate a manifest from OpenAPI" is not
a contract. It says nothing about who holds credentials, what happens
when the spec changes under a running deployment, or what a receipt for a
generated call is supposed to contain.

The adapter is deliberately small. It discovers and it binds requests.
Everything downstream, including risk, approval, audit, and rollback, is
the runtime's, because an adapter author is not the right person to be
making security decisions for someone else's application.

```ts
type Adapter = {
  readonly name: string;
  discover(source: SourceRef): Promise<DiscoveryResult>;
  bind(entry: CapabilityManifestEntry, input: unknown): RequestPlan;
  interpret(entry: CapabilityManifestEntry, response: RawResponse): Outcome;
};
```

Three methods, and none of them is `execute`. The runtime executes. An
adapter that could execute could bypass the policy engine.

## Discovery

`discover` takes a reference to a specification and returns entries plus
the reasons it could not produce more.

```ts
type SourceRef =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string; headers?: Record<string, string> }
  | { kind: "inline"; document: unknown };

type DiscoveryResult = {
  entries: CapabilityManifestEntry[];
  /** Operations found and deliberately not emitted, with the reason. */
  skipped: Array<{ ref: string; reason: string }>;
  /** Hash of the source document, for drift detection. */
  sourceDigest: string;
};
```

`skipped` is not optional and not a log line. An adapter that silently
drops the twelve operations it did not understand produces a manifest
that looks complete and is not, and the person reviewing it has no way to
tell. `agentdesk inspect` prints skipped entries next to emitted ones.

Discovery is pure with respect to the application. It reads a
specification. It does not call the API to find out what exists, because
probing an unknown endpoint to discover its shape is indistinguishable
from attacking it.

Every emitted entry carries `provenance.semanticProvenance` set by the
adapter honestly. An adapter that marks structural guesses as `contract`
to get better default treatment has broken the only property that makes
the tier useful.

## Compilation

Compilation is not the adapter's. `compileManifestEntry(entry, adapter,
policy)` in `@agentdesk/auto` turns an entry into a `Capability`, and it
is the only place that constructs one.

The split matters because compilation is where the safety defaults from
`auto-sdk.md` apply. Any mutation is CONSEQUENTIAL, `unknown` is
CONSEQUENTIAL, and a consequential entry with no `approvalEvidence` is a
compile error. If adapters compiled their own capabilities, each adapter
author would reimplement that judgment, and the eleventh one would get it
wrong.

What the adapter contributes to compilation is `bind` and `interpret`,
closed over by the generated `execute`. The adapter never sees
`ExecutionContext` and never sees the approval decision.

## Execution

The runtime calls `bind`, applies policy, and only then issues the
request. The adapter describes the request; it does not send it.

```ts
type RequestPlan = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Fields the adapter considers safe to show a human verbatim. */
  previewable: Record<string, unknown>;
};
```

Returning a plan rather than performing a fetch is what makes approval
possible. A human approving a consequential call is approving a specific
request, and the only way to show them one is to have the request in hand
before it is sent. It also means the transport is the runtime's, so
timeouts, retries, and the abort signal behave identically across
adapters.

`previewable` is the adapter's judgment about its own payload. A refund
body has an amount and an order id worth showing, and it may have an
idempotency key worth omitting. Omitting a field from `previewable` never
omits it from the request.

Retries are the runtime's, under the existing idempotency contract in
`docs/architecture.md`. An adapter that retries internally would produce
two charges under one execution id.

## Authentication

An adapter never holds a credential.

This is the rule most likely to be broken by an adapter author, because
holding the token is convenient and the API is right there. It is
disqualifying for the same reason a `postinstall` that edits
`next.config.ts` is disqualifying. A package whose job is authorizing
actions cannot also be the package that quietly accumulates the ability
to take them.

```ts
type AuthBinding =
  | { kind: "none" }
  | { kind: "forward-session" }
  | { kind: "header"; name: string; secretRef: string }
  | { kind: "bearer"; secretRef: string };
```

The adapter declares which binding an operation needs and names the
secret. The runtime resolves `secretRef` and injects the value after
`bind` returns, so the credential never enters adapter code and never
appears in a `RequestPlan` the approval UI renders.

`forward-session` is the browser case, where the request rides the user's
existing cookies. It is the most dangerous binding and needs saying out
loud, because it means an approved call runs with the full authority of
whoever is logged in. Same-origin only, and never on an `augment` origin
the user did not explicitly enable.

Nothing here solves consent for a third-party API on the user's behalf.
That is an OAuth problem and it is out of scope for v1.

## Request binding

`bind` maps validated input onto a concrete request. Input arrives
already validated against `inputSchema`, so `bind` does not re-validate,
per the boundary rule that the runtime owns the boundary.

Path parameters are substituted by name, not by position. Query and body
placement follows the source specification rather than a convention.
Anything the specification did not describe is not sent, so an extra
property in the input is dropped rather than forwarded, and dropping it is
reported in the receipt.

A binding failure is a typed error naming the entry and the field. It is
never a partially built request. The failure modes worth enumerating are
a missing required path parameter, a value that survived schema
validation but cannot be serialized into its declared location, and a
`secretRef` the runtime could not resolve.

## Validation

Validation happens twice, at two different boundaries, and conflating
them is how generated surfaces get holes.

Input validation is the runtime's, against `inputSchema`, before `bind`.
The adapter's contribution is producing a schema faithful to the source.
A schema looser than the specification is the defect that matters,
because the runtime cannot reject what the schema permits.

Response validation is the adapter's, in `interpret`. The application's
response is external data crossing back into the typed model, so it is
parsed rather than cast.

```ts
type Outcome =
  | { kind: "ok"; result: unknown; changes: Change[] }
  | { kind: "failed"; code: string; message: string; retryable: boolean };
```

`interpret` reports `changes` when the response describes what it
altered, and an empty array when it does not. An empty array is honest.
Fabricating a change record from the request, so a receipt looks complete,
makes the audit assert something nobody observed.

Response content is untrusted. `contentTrust` is `untrusted` on every
generated capability, and `interpret` does not get to raise it.

## Receipts

A receipt for a generated call proves what was sent and what came back,
which is a weaker claim than a hand-written capability makes and should
read that way.

| Field | Source |
| --- | --- |
| `request` | The `RequestPlan`, with `secretRef` values redacted |
| `response` | Status and the parsed `Outcome` |
| `changes` | From `interpret`, empty when the response did not say |
| `provenance` | The entry's four dimensions, copied at compile time |
| `sourceDigest` | The digest discovery recorded |
| `droppedInput` | Input properties `bind` did not send |

Redaction happens on the way into the receipt, not on the way out to a
display. A secret that reaches the receipt store has leaked, and every
later consumer of that store inherits the leak.

`sourceDigest` is what makes an old receipt interpretable. Without it, a
receipt from three deployments ago describes a capability whose shape
nobody can reconstruct.

Storage, query, and review are the existing `ReceiptStore`. Adapters add
fields; they do not add a second history.

## Drift detection

A specification changes and the manifest does not. That is the failure
this section exists for, and it is silent by default.

Two digests answer two different questions. `sourceDigest` says the
specification changed. A per-entry `shape` digest over name,
`inputSchema`, `mutability`, and the executor says whether this operation
changed.

| Observation | Meaning | Response |
| --- | --- | --- |
| `sourceDigest` differs, no entry shape differs | Cosmetic edit | Record, continue |
| An entry's shape differs | The operation changed | Quarantine that entry |
| An entry is gone from discovery | Removed or renamed | Quarantine, never silently drop |
| A new entry appears | Added upstream | Do not register without review |

Quarantine means the capability stops executing and starts reporting why.
It does not mean falling back to the old shape, because the old shape is
the thing now known to be wrong.

A new operation appearing upstream must not become an agent-invocable
capability without a human. Otherwise the security boundary of a
deployment is whoever can merge to the API specification, which is a
supply-chain hole with a generator in front of it.

Drift is checked at `init`, in CI through `agentdesk check`, and at
runtime startup when the source is a URL. The CI check is the one that
matters, because it fails a build rather than a request.

This is deliberately not the runtime's `expectedRevision` drift
detection, which is about application state changing under a plan.
`docs/architecture.md` covers that. This is about the contract itself
moving, and the two are independent.

## What the staging contract did not say

Status: implemented. This section is about a different contract from the
one above: `StagingAdapter` in `packages/webmcp/src/staging.ts`, the
fork, diff, commit, release interface an application binds once so the
runtime can derive the evidence a human approves. It had one
implementation, the demo's in-memory store. The second, `indexedDbStaging`
in `packages/webmcp/src/indexeddb-staging.ts`, is over a store that is
neither in memory nor synchronous, and building it showed where the
contract is silent. Each item is something the implementation needed and
the contract did not say.

1. **Resolved for fork; diff stays synchronous by decision.** `fork` may
   now return a promise, and the runtime awaits it before `diff`, so a
   store that reads over the network is driven by the runtime like any
   other. `diff` still returns a value, because it derives from the fork
   alone and is what a person reads at request time. The IndexedDB adapter
   keeps a synchronous fork over a mirror by choice, since the rows an
   operation names are discovered by running it; the contract still has no
   `open` or ready hook for that mirror, so the application awaits the
   adapter's own `open()` before the runtime starts.

2. **Resolved: a commit that has returned can no longer report a
   completion that rolled back.** This was a correctness gap. The only
   check that sees a second tab is the version check inside the commit's
   own transaction, and its outcome arrived after `commit` had returned,
   so the runtime had recorded `execution_completed` for a write the
   database then refused. `commit` may now return a promise, the runtime
   awaits it before recording anything, and a rejection is classified the
   way a throw is: a refusal names itself with `StagedCommitRefused` or
   `CapabilityUnavailableError`, and anything else is indeterminate. The
   IndexedDB adapter's commit is the transaction's own outcome, and its
   mirror moves only when the transaction completes. `release` may return
   a promise too. What remains true is the corollary: for a transactional
   store, an abort is a rollback the database vouches for, and the one
   abort it does not vouch for, a connection lost while committing, is
   the one the adapter reports as indeterminate.

3. **A commit interrupted by an unload leaves no runtime record.**
   `StagedCommitIndeterminate` exists only when `commit` throws. A page
   that unloads between `commit` returning and its transaction completing
   throws nothing, so the fork's row in the staging store is the only
   trace, and the contract never asks an adapter what it found open at
   start. The adapter loads those forks and `resolveArtifact` can hand
   them back, but the runtime has no record to ask with.

4. **`identify` is consulted only when the artifact does not clone.** An
   artifact made of plain rows clones, so the record would carry a second
   copy of the rows rather than the key, and the two copies could
   disagree. The adapter makes its artifact deliberately uncloneable by
   keeping the operation on it as a function. An adapter should be able to
   say "key me" without that trick.

5. **`resolveArtifact` assumes the artifact still exists.** The fork's row
   is deleted in the commit's own transaction, because that is what makes
   the commit atomic, so a landed commit's fork is gone by the time a
   record of an unknown outcome asks for it. Here the absence is the
   answer: a row deleted only by a completed commit or a release. The
   adapter hands back an empty fork under the id so the record can still be
   settled, and the reference carries the operation name too, because an
   id alone rebuilds nothing.

6. **`previous` and `restage` are offered without a way to decline them.**
   Nothing here is pinned to a clock or a seed, so `previous` is ignored
   and `restage` is never called. The contract should say that an adapter
   may ignore both, and that ignoring them means a second run of the same
   input against the same rows is the same run.

7. **What "the state the human reviewed" is, is the adapter's to invent.**
   The contract's `stateDigest` covers each change's field and `before`
   value. Whether a row an operation only read is part of the reviewed
   state, and what a row's version is, the contract leaves open. This
   adapter puts every row the operation read or wrote in the fork's base
   at its version, so a decision made on a row that later moved is refused
   even when the diff did not mention that row.

### What the REST adapter needed

The third implementation, `restStaging` in
`packages/webmcp/src/rest-staging.ts`, is over a backend with no
transaction and no local state. Same shape: each item is something it
needed that the contract did not say.

1. **Resolved: fork has an asynchronous half.** A REST row can only be
   read with a round trip, and `fork` returned a value, so the adapter
   needed a `prepare` the runtime never called. `fork` may now return a
   promise and the runtime awaits it, so the adapter's fork fetches the
   rows the operation names and runs it, `prepare` is gone from its
   surface, and a staged capability over REST is driven with nothing but
   `invoke` and `approve`. What the contract now says about the wait: the
   idempotency slot is claimed before the fork, so a repeat under the same
   key while the fork is in flight joins the first request rather than
   forking again, and a scope handed a promise stays open until it settles.

2. **The rows an operation names are not part of the contract.** The
   IndexedDB adapter learned them by watching the draft; REST has to know
   them before the operation runs, because they are what `prepare`
   fetches. So an operation here declares `rows(input)` next to `run`, and
   a read or write of a row it did not declare is refused. The contract
   has `operations` as a set of names, not as anything with a shape.

3. **Partial application has no vocabulary.** `StagedCommitIndeterminate`
   carries the approved changes and a reason; a REST commit that stopped
   after the second of four writes knows exactly which rows were
   acknowledged, at which versions, which was refused, and which were
   never sent, and the only place to put that is the reason's message.
   `RestCommitPartial` carries it structurally, but the record the runtime
   keeps has a `detail` string and nothing else, and a human reconciling
   reads prose.

4. **The version an acknowledged write returns is the next fork's base.**
   Inside a scope the second operation derives against the first's staged
   head, and its `If-Match` has to be the version the server gave the
   first write, which does not exist until that commit answers. The
   adapter records which fork a base row follows and resolves it at
   commit; the contract's `scope` says forks chain, and nothing about how
   a chained commit learns what it must match.

5. **"Nothing written" is the backend's word, not the adapter's.** With a
   batch endpoint the adapter reports a 412 as a refusal because the
   backend promises a batch is all or none; the contract lets an adapter
   say `StagedCommitRefused` and has no way to say on whose authority.

<!-- code-anchors
packages/webmcp/src/receipts.ts ReceiptStore StoredReceipt
packages/webmcp/src/capability.ts Change RiskLevel untrustedContentHint
packages/webmcp/src/plan.ts expectedRevision
packages/webmcp/src/staging.ts StagingAdapter StagedCommitIndeterminate StagedCommitRefused stateDigest identify buildStageHandler scope
packages/webmcp/src/runtime.ts runInvocation
packages/webmcp/src/rest-staging.ts restStaging RestCommitPartial fetchRows rows follows acknowledged
packages/webmcp/src/runtime.ts stageFor currentDigest
packages/webmcp/src/indexeddb-staging.ts indexedDbStaging open flush resolveArtifact STAGING_STORE
packages/webmcp/src/runtime.ts describeArtifact
-->
