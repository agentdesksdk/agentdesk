# AgentDesk Universal, browser extension design

Status: design only. Nothing here is implemented.

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

## Capability sources

**Native WebMCP already on the page.** Discovered with `getTools()`. The
site's author declared these, so they are the highest-trust source, and
AgentDesk adds routing, policy, and audit only. Parse `inputSchema`; in
Chrome 152 it comes back as a JSON string rather than the object the IDL
declares.

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

Inferred capabilities route exactly like authored ones. That works today
without modification: `Capability.execute` is an arbitrary function, and
the runtime already accepts an injectable `adapter`. Only four files in
`packages/webmcp/src` reference the adapter at all, so the `@agentdesk/core`
extraction this needs is closer to a rename than a rewrite.

## Risk defaults

An inferred capability is CONSEQUENTIAL unless something authoritative
says otherwise. Reads and navigation earn lower risk only from structure
the page actually declares.

A classifier may propose that a button looks safe. Policy decides whether
it runs. Those are different components and the model is never the second
one.

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
  matches: ["<all_urls>"],
  registration: "runtime",
  runAt: "document_idle",
  world: "ISOLATED",
  async main(ctx) { /* core boots here */ },
});
```

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

I would not build this before the hackathon submission. It is the most
interesting product here and the most dangerous, since it operates inside
authenticated sessions with inferred semantics. It deserves a security
review, not a deadline. Deployment, the compatibility matrix, and the
video are worth more this week.

I would not build the signed adapter registry in v1. Signing,
distribution, revocation, and trust roots are a product on their own. Ship
built-in adapters in the extension bundle, versioned with the extension,
and let a registry follow once inference has proven worth curating.

The first milestone worth anything is narrow. Run the ISOLATED
registration experiment. Then one origin, opt-in, forms only, no
imperative generation, no MAIN world, bootstrap contract registered, audit
visible. That tests every load-bearing assumption here and is cheap to
throw away if Chrome 153 changes the declarative behaviour.
