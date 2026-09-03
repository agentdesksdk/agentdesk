# AgentDesk Universal, browser extension design

Status: the first slice is implemented, the provider and the bridge in
`packages/extension`; "What has landed" below says exactly which of this
document's assumptions that slice satisfies and which it does not. The
rest is design.

Goal. Make a site that never integrated AgentDesk agent-capable, without
touching its source, while keeping the governance properties that make
AgentDesk worth using.

Read `declarative-webmcp-findings.md` first. Several decisions below exist
because of what that measurement showed, not because of what the docs say.

## The constraint that shapes everything

Chrome documents what an extension may do with WebMCP in exactly one
sentence, on the tool-security page: extensions can **query and execute**
WebMCP tools using content scripts, given `host_permissions`. Every other
mention of extensions in Chrome's WebMCP docs and in the spec frames them
as *agents*, the side that consumes.

An extension **registering** a tool is undocumented everywhere. Not
prohibited, not endorsed, absent. The spec's only extension-related
standards-track request asks for an API to *enumerate and invoke*, not to
provide. Chrome's own feature-availability table leaves the Extensions
cell for WebMCP empty.

One documented fact cuts against that framing. `registerTool`, `getTools`,
and `executeTool` are methods on the same `ModelContext` object, so
whichever world reaches `document.modelContext` gets all three. "Query and
execute" is a statement of intended use, not an enforced capability split.

So this design sorts its capability sources by how much documented ground
they stand on, and it does not pretend the risky ones are safe.

| Source | Standing | Evidence |
| --- | --- | --- |
| Consume existing WebMCP tools | Documented | Chrome states it explicitly |
| Declarative attribute injection | Undocumented, **measured working** | Chrome 152, this repo |
| Imperative `registerTool` from an extension | Undocumented, **unmeasured** | Nothing, either way |

## The one experiment to run before building anything

Whether an ISOLATED-world content script can call
`document.modelContext.registerTool` and have the page's `getTools()` see
the result is an implementation detail with no documentation in either
direction. It cannot be settled by reading; it needs an extension loaded
with `chrome://flags/#enable-webmcp-testing`.

I could not run it from here because it needs a real extension, not a CDP
evaluate. It is the first milestone, ahead of any product work, because
the answer moves the whole architecture:

- **If ISOLATED registration works**, the trusted core registers tools
  directly and MAIN world is never needed.
- **If it does not**, imperative capabilities require injecting a script
  into MAIN, which means the page's CSP applies to it and the page can
  interfere with it. For an extension operating inside authenticated
  sessions, that is a material downgrade and may be reason enough to ship
  declarative-only.

Write the result into `declarative-webmcp-findings.md` alongside the
measurements already there.

## Trust layout

```text
background service worker      enabled origins, adapter bundles
      │                        no page access
      ▼
ISOLATED content script        AgentDesk core: catalog, routing, policy,
      │                        approval, audit. Every trusted decision.
      │
      ├── DOM scanner ───────────────► reads the page
      ├── declarative writer ────────► sets toolname / tooldescription
      │
      ▼ only if the experiment says ISOLATED registration fails
MAIN world script              registerTool only, untrusted courier
```

No decision is made in MAIN. Chrome documents that a main-world script
runs under the page's CSP and shares the page's execution environment, so
anything reachable there is assumed tampered. MAIN registers and relays.
It never evaluates policy, holds the audit log, or decides what is
consequential.

## Two enforcement modes

The extension cannot enforce uniformly across every capability on a page,
and an earlier draft of this document assumed it could. A tool the site
registered imperatively has no removal handle the extension can reach.
`removeAttribute` retires a form-derived tool because the attribute is in
the DOM the content script shares. Nothing equivalent exists for a tool
registered through `document.modelContext.registerTool` by page script.
The extension can enumerate and invoke that tool. It cannot retire it,
rename it, or stand in front of it.

So every capability carries a mode, and the mode decides which guarantees
AgentDesk is allowed to claim.

| Mode | Registration owner | AgentDesk can enforce | AgentDesk cannot |
| --- | --- | --- | --- |
| `owned` | AgentDesk | Virtualization, policy, approval, audit | — |
| `augment` | The website | Discovery, guidance, its own audit of its own calls | Hiding, interception, exclusive approval |

`owned` covers declarative tools the extension authored by attribute
injection and, if the registration experiment passes, imperative tools it
registered. `augment` covers everything the page registered itself.

In `augment` mode the agent sees the site's tools alongside AgentDesk's.
The honest claim is that AgentDesk adds a governed path and a record of
what it did, not that it is the only path. Any UI that implies otherwise
is lying to the operator. The inspector must label augmented origins as
such.

## Capability sources

**Native WebMCP already on the page.** Discovered with `getTools()`.
Always `augment` mode. Parse `inputSchema`; in Chrome 152 it comes back
as a JSON string rather than the object the IDL declares.

The site's author declared these, which makes them authoritative about
the site's own mechanics and says nothing about whether their text is
safe to feed a model. Provenance is not one axis, and collapsing it into
"highest trust" was the earlier draft's mistake. Four independent
dimensions:

```ts
type CapabilityProvenance = {
  /** Where the declaration came from. */
  sourceKind: "native" | "declarative" | "inferred" | "authored";
  /** How much the source knows about what the operation means. */
  semanticProvenance: "declared" | "contract" | "structural" | "observed";
  /** Who runs it, and therefore who can enforce a gate on it. */
  executionOwnership: "agentdesk" | "page" | "browser";
  /** Descriptions and outputs are attacker-controlled until proven otherwise. */
  contentTrust: "untrusted";
};
```

`contentTrust` has one value on purpose. A tool description and a tool
result are page-authored strings on their way into a model's context, so
they are untrusted on every source including native. The runtime already
carries this as `untrustedContentHint` on a capability. The extension
sets it for every discovered tool without exception.

The dimensions move independently. A native tool is `sourceKind: native`,
`semanticProvenance: declared`, `executionOwnership: page`, and still
untrusted content. That combination is precisely why it is high quality
and unenforceable at the same time.

**Declarative, by attribute injection.** Measured working. The scanner
finds a form, derives a name and description, sets `toolname` and
`tooldescription`, and Chrome derives the schema from field names,
`toolparamdescription`, and HTML `required`. Retiring a tool is one
`removeAttribute`. This is the largest source and needs no
`document.modelContext` access at all, which is why it survives even if
the registration experiment fails.

It is also the least stable. The spec section for declarative WebMCP is
marked entirely TODO, and this behaviour is undocumented for extensions.
Keep it behind one module with a contract narrow enough to swap.

**Imperative, generated from DOM structure.** Navigation, tables, buttons.
Lowest trust, blocked on the experiment above.

## The approval boundary

Never add `toolautosubmit` to a form the extension did not author. This is
the most important rule here.

The measurement showed why. Without `toolautosubmit`, Chrome fills the
form fields and leaves the tool call pending until a human submits. That
is a native human-in-the-loop gate, implemented by holding the promise
open, which is the exact opposite of AgentDesk's rule that a consequential
call returns `APPROVAL_REQUIRED` immediately and never blocks.

Two gates on one action means neither is authoritative, so the boundary is
assigned per capability kind rather than layered.

For a declarative form, Chrome's gate wins. AgentDesk routes the right
form into the surface, records the intent, and shows what was filled. It
adds no approval card. The cost is that the call blocks, and that cost is
disclosed in the tool description rather than hidden, so a client knows
the call will not return promptly.

### Completion accounting

Ceding the gate does not cede the record. If AgentDesk logs only what the
agent asked for, the audit proves what was filled and not what a human
ultimately submitted, and those differ exactly when it matters. A person
who corrects the amount from 5000 to 50 before submitting, or who
abandons the form, leaves an audit saying 5000 was requested and nothing
saying what happened next.

So a form-derived capability records three events, not one.

| Event | Source | Recorded |
| --- | --- | --- |
| `filled` | Our own `executeTool` call | The values the agent supplied |
| `submitted` | `submit` listener on the form | The values actually in the fields at submit |
| `abandoned` | Navigation or teardown with no submit | That the call never completed |

The submitted values come from reading the form's own elements in the
`submit` handler rather than from the agent's input, because the point is
to capture the human's edit. Listen in the capture phase so a handler
that calls `preventDefault` does not hide the event, and treat a
`submit` event whose `defaultPrevented` is true as intent rather than
completion, since the page may be running its own validation.

Activation matters too. A tool call sits pending until the human acts, so
the extension records when the form was focused or otherwise activated.
A call that was never activated is a different failure from one that was
activated and rejected, and the operator reviewing an audit needs to tell
them apart.

None of this is inferable after the fact, which is why it belongs in the
first milestone that ships a declarative form rather than in a later
audit pass.

For imperative capabilities the extension authored, AgentDesk's two-phase
approval applies normally, because the extension controls execution.

## Bootstrap contract, not a tool dump

Four tools per origin, never the generated catalog:

```text
agentdesk_get_context
agentdesk_find_capabilities
agentdesk_invoke_capability
agentdesk_get_action_status
```

Same contract the SDK ships, so an agent sees one stable interface whether
a site integrated AgentDesk or not. It also avoids the failure the
proposal correctly identifies, where scanning a CRM yields 117 tools and
recreates the context problem AgentDesk exists to solve.

**This holds in `owned` mode only.** "Never the generated catalog" is a
statement about what AgentDesk registers, not about what the agent can
see. On an `augment` origin the site's own tools stay listed next to
these four, because the extension has no way to withdraw them. The
reduction is real for everything AgentDesk owns and is not a promise
about the page as a whole.

Inferred capabilities route exactly like authored ones, because
`Capability.execute` is an arbitrary function and the runtime accepts an
injectable adapter.

The provider boundary this document assumed has been extracted, and the
shape that landed is narrower than the sketch here first proposed. A
`CapabilityProvider` in `packages/webmcp/src/provider.ts` supplies
`capabilities()`, an `adapter` the runtime's tool surface drives, and an
optional `subscribe` that announces a changed catalog; it does not start or
stop the surface, because the surface stays the runtime's.
`createAgentDeskRuntime` takes one and constructs no WebMCP-specific
object; `nativeProvider` is the shipped path, and a source-scan test holds
`provider.ts` as the only place the adapter is built.

What the seam now satisfies of this document's assumptions: inferred
capabilities route, apply policy, and audit exactly like authored ones,
because they arrive through the same `capabilities()`; the extension's
`registerTool`, run from whichever world Gate 2 settles on, is the
`adapter` it hands the runtime and the runtime never reaches past it; and
a catalog that changes as the page changes is announced through
`subscribe`, on which the runtime reconciles the surface. What it does not
yet satisfy: provenance per capability beyond `untrustedContentHint`, the
four-dimension `CapabilityProvenance` above, which is still a proposal.

## What has landed

`@agentdesksdk/extension`, in `packages/extension`, holds the first slice: the
extension context as a `CapabilityProvider`, and the bridge between the
page and it. It depends on `@agentdesksdk/webmcp` through its published
exports and contains nothing else: no UI, no scanner, no store listing, no
WXT entrypoints. It is not published; it is the seam the entrypoints will
be written against.

**The provider.** `extensionProvider({ manifest, registerTool, window })`
supplies `capabilities()` from a manifest the extension holds for one
origin, handlers included, so nothing the page says becomes a capability;
a manifest whose capabilities are a function answers from the DOM as it
is now, which is where a scanner will plug in. Its `adapter` is the
extension's own `registerTool`, the isolated world's model context once
Gate 2 settles which world that is, so registration never crosses into
page script: a test spies on the page's `postMessage` and its `message`
listeners through a registration and sees nothing, and the page gains no
global. `subscribe` fires when the page reports a change through the
bridge or when the extension replaces the manifest, and the runtime reads
the catalog again and reconciles the surface. Routing, policy denial, and
approval over bridged capabilities are tested equal, result for result and
tool for tool, to the native provider over the same specs. A manifest for
another origin needs a provider of its own.

**The bridge, which is the security-relevant part.** A page message is a
request and never an authorization, as `docs/mcp-b-interop.md` requires.
The bridge checks origin, then source, then shape, in that order, so a
message from the wrong origin is refused before its shape is read and
cannot probe the bridge from elsewhere; origin and source are routing
facts, not authentication, which is why the request vocabulary is the
whole of what a page can cause. That vocabulary is three requests: look
again (`changed`), remember the reveal anchors the site placed
(`anchors`), and reveal one of them (`reveal`). Anything else addressed to
the bridge, an approve, an execute, a register, is a forgery and is
refused as `not_a_request`. A request carrying an authorization claim,
`approved`, `actor`, `by`, `token`, is refused whole rather than stripped,
so nothing downstream sees a message that once carried one. A request
naming a DOM node, `selector`, `target`, `element`, `xpath`, wherever it
sits in the message, is refused as `dom_target`; a reveal names only a
token matching the grammar `docs/accessibility.md` fixes, and only one the
page registered. Every refusal is structured, with the reason and the
detail, and every refusal is the runtime's audit event: the bridge hands
it to the provider, the provider to the `refused` hook the runtime gave
it at `start`, and it is recorded as `provider_refused` beside every
denied call, with the bridge's reason and a detail carrying its own
sentence, the origin the message came from, and the kind it claimed. The
bridge keeps no log of its own, because two logs of one refusal are two
places for an operator to look and one of them to be stale; a refusal
that arrives before the runtime has connected is held and recorded once
it has, and if the hold overflows, the drop is recorded too, as one
`held_overflow` naming how many were dropped and over what span, ahead of
the replay. Traffic that never addressed the bridge is not audited.

**What this slice leaves unsatisfied**, so no reader takes the package for
the product:

- Gate 2, the ISOLATED-world registration experiment, is unrun. The
  provider takes `registerTool` as a function precisely so the answer can
  be wired in without changing it, but which world supplies that function
  is still the open question this document says it is.
- No capability source is built. Native tools on the page, declarative
  attribute injection, and structural inference are all still design; the
  manifest's capabilities are the extension's own specs, and the scanner
  that would fill them from a page does not exist.
- Completion accounting, `filled`, `submitted`, and `abandoned`, is not
  built, because no form-derived capability exists to account for.
- Provenance per capability is still `untrustedContentHint` alone; the
  four-dimension `CapabilityProvenance` is a proposal.
- The permission model, the enabled-origins gate in the service worker,
  and the WXT entrypoints are not built. The bridge is bound to one origin
  by its manifest, which is the shape the enabled-origins gate will hand
  it, not the gate itself.

<!-- code-anchors
packages/webmcp/src/provider.ts CapabilityProvider nativeProvider subscribe
packages/webmcp/src/runtime.ts ToolSurfaceManager provider
packages/webmcp/src/capability.ts untrustedContentHint RiskLevel
packages/webmcp/src/webmcp-adapter.ts createWebMcpAdapter
packages/extension/src/provider.ts extensionProvider ExtensionProvider replace connect HELD_REFUSALS
packages/extension/src/bridge.ts onRefused BridgeRefused
packages/webmcp/src/audit.ts provider_refused
packages/extension/src/bridge.ts attachBridge BridgeRequest BridgeRefusal REQUEST_KINDS DOM_TARGET_KEYS AUTHORIZATION_KEYS ANCHOR validate
packages/extension/src/manifest.ts ExtensionManifest
-->


## Risk defaults

An inferred capability is CONSEQUENTIAL unless something authoritative
says otherwise. Reads and navigation earn lower risk only from structure
the page actually declares.

A classifier may propose that a button looks safe. Policy decides whether
it runs. Those are different components and the model is never the second
one.

The two axes are the same ones `auto-sdk.md` defines. `mutability` says
whether the operation changes state and `consequence` says whether a human
has to see it first, and only the second one gates. `WRITE` does not stop
for a human in this runtime, so an inferred mutation is CONSEQUENTIAL
rather than `WRITE`. Nothing the extension infers may be downgraded by
inference; a downgrade needs an origin-level override a person wrote.

## Permissions

`activeTab` is not sufficient, and the earlier draft of this document was
wrong to lead with it. It grants temporary, gesture-scoped access that is
revoked on cross-origin navigation, and it only permits
`scripting.executeScript` when `scripting` is also declared. Chrome's
WebMCP note is explicit that extensions need `host_permissions` to access
the page.

So the model is `activeTab` plus `scripting` for the first-run scan
triggered by a click, then an explicit per-origin grant through
`optional_host_permissions` for standing operation. The enabled-origins
list lives in the service worker and is the only thing that turns scanning
on. No `<all_urls>` at install.

Three further documented gates constrain where this can work at all.
WebMCP is `SecureContext`, is unavailable in documents that opt out of
origin isolation with `Origin-Agent-Cluster: ?0`, and is gated by the
`tools` Permissions Policy which defaults to `self`. Feature-detect all
three and degrade to a visible "not available on this page" state rather
than failing silently.

## WXT specifics

WXT is a good fit and its conventions decide several file-level choices.

Entrypoints live in `entrypoints/`, one level deep at most. A content
script is `agentdesk.content.ts` exporting `defineContentScript`. A bare
`{name}.ts` is an unlisted script, which is the vehicle for the MAIN-world
shim if it is needed.

```ts
export default defineContentScript({
  matches: [],
  registration: "runtime",
  runAt: "document_idle",
  world: "ISOLATED",
  async main(ctx) { /* core boots here */ },
});
```

`matches` is deliberately empty. WXT's `registration: "runtime"` omits the
script from the manifest's `content_scripts` and copies whatever `matches`
holds into `host_permissions`, so writing `["<all_urls>"]` here would
request broad host access at install and contradict the permission model
above. An earlier draft did exactly that, and the contradiction is the
reason this note exists. The real match list is supplied per origin at
`browser.scripting.registerContentScripts` time, after a grant.

Values are snake_case (`document_idle`) even though the option names are
camelCase. A `world: "MAIN"` entrypoint's `main()` receives no `ctx`.

**Do not use `world: "MAIN"` for the shim.** WXT recommends against it,
it is Chromium-only, and a main-world content script has no extension API
access. The documented pattern is an unlisted script listed in
`web_accessible_resources`, injected from the isolated script:

```ts
await injectScript("/agentdesk-main-world.js", { keepInDom: true });
```

Two WXT gaps to plan around. `registration: "runtime"` only omits the
script from the manifest and copies `matches` into `host_permissions`;
there is no wrapper for `browser.scripting.registerContentScripts`, so
registration is hand-written against hardcoded built paths such as
`content-scripts/agentdesk.js`. And `optional_host_permissions` passes
through at runtime but does not typecheck, needing a `@ts-ignore` in
`wxt.config.ts`.

WXT ships storage but no messaging library. Storage keys need an area
prefix (`local:enabledOrigins`), and tests mock `wxt/utils/storage` rather
than `#imports`. Testing uses the `WxtVitest` plugin with
`fakeBrowser.reset()` per test, which matters here because the
enabled-origins gate is the security boundary and deserves real tests. Use
the `browser` namespace throughout, never `chrome`.

## Where this sits against the SDK

The extension is distribution and the SDK is the upgrade path. Inference
cannot recover what the page never expressed. A refund UI showing
`Amount`, `Reason`, `Submit` yields `refund_visible_payment`, with no way
to know about ledger strategy, fraud override, or accounting period. The
site's developers do know.

The honest pitch is that the extension makes the web agent-capable today
at inferred quality, and its inspector shows a site owner exactly which
capabilities are guesses. That list is the most credible argument for
installing the SDK.

## Sequencing, and what I would not do

This is the most interesting product here and the most dangerous, since it
operates inside authenticated sessions with inferred semantics. The gate
on building it is a security review, not a date.

I would not build the signed adapter registry in v1. Signing,
distribution, revocation, and trust roots are a product on their own. Ship
built-in adapters in the extension bundle, versioned with the extension,
and let a registry follow once inference has proven worth curating.

## The first milestone branches on the experiment

The first milestone cannot be stated as a single deliverable, because an
earlier draft promised one that contradicts itself. It listed "forms
only, no MAIN world" together with "bootstrap contract registered", and
those cannot both hold. Attribute injection registers form tools. The
four `agentdesk_*` tools are imperative, so they need
`document.modelContext.registerTool` from somewhere, which is the exact
question the experiment exists to answer.

Run the experiment first, then take the branch it selects.

| Result | Milestone 1 delivers | Bootstrap virtualization |
| --- | --- | --- |
| ISOLATED registration works | One origin, opt-in, forms plus the four bootstrap tools registered from the trusted core, audit visible | Promised, `owned` mode |
| ISOLATED fails, MAIN acceptable | The same, with registration relayed through a minimal MAIN-world courier that decides nothing | Promised, `owned` mode, with the courier's tamper exposure documented |
| ISOLATED fails, MAIN excluded | One origin, opt-in, declarative forms only, completion accounting, audit visible | Not promised, and not implied anywhere in the UI |

The third row is a real product, not a failure state. Declarative forms
with honest completion accounting on an `augment` origin still beat no
governance at all. What it must not do is claim a reduced tool surface it
cannot deliver.

Each branch is cheap to throw away if Chrome 153 changes the declarative
behaviour, which is the point of sizing the milestone this way.

### Gates

Milestone 1 is done when all of these hold on one real origin.

- The registration experiment has a written result in
  `declarative-webmcp-findings.md`, pass or fail.
- No host permission is requested at install, verified by reading the
  built `manifest.json`.
- A form-derived call produces `filled`, `submitted`, and `abandoned`
  records, with submitted values read from the form rather than from the
  agent's input.
- Every discovered capability carries all four provenance dimensions, and
  the inspector shows the origin's mode.
