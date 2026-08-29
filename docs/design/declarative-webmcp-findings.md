# Declarative WebMCP, measured

Chrome 152.0.0.0 on Windows, 2026-08-29, driven over CDP against the P0
harness and the demo app. Everything here was observed, not inferred. The
two designs in this directory depend on these facts, so they are recorded
separately and can be re-run when Chrome moves.

## Attribute injection registers a real tool

Creating a form with `toolname` and `tooldescription` and appending it to
the document registered it. `getTools()` went from the four AgentDesk
bootstrap tools to five, with `search_products` present.

The same worked on a form the page already owned. Setting `toolname` and
`tooldescription` on the demo app's existing "Route a task" form
registered `route_task` without touching application source.

**Consequence for the extension.** Form-derived capabilities need no
`registerTool` access at all. A content script shares the page's DOM, so
attribute injection is sufficient, and Chrome performs the registration in
the page's own context. This removes the isolated-world question from the
critical path for the largest capability source.

## Chrome derives the schema from the markup

For an input named `task-query` carrying `toolparamdescription`:

```json
{"type":"object","properties":{"task-query":{"type":"string","description":"The task to route"}},"required":[]}
```

Adding the HTML `required` attribute moved the field into `required`.
So the mapping is field `name` to property key, `toolparamdescription` to
`description`, and HTML `required` to schema `required`.

## `inputSchema` comes back as a JSON string

`RegisteredTool.inputSchema` was `typeof "string"`, not an object, while
the spec IDL types it as `object`. This is the second string/object
divergence found in this browser, alongside `executeTool` requiring a
pre-serialized string. Anything consuming `getTools()` must parse it.

## Removing `toolname` unregisters

Deleting the attribute dropped the tool from `getTools()` on the next
query. Retirement therefore costs one `removeAttribute`.

## Execution without `toolautosubmit` blocks on a human

This is the most consequential finding.

A form with no submit button and no `toolautosubmit` refused to register
an execution at all:

```text
UnknownError: No submit button was found, but for a form without
`toolautosubmit`, there must be a submit button
```

With a submit button and no `toolautosubmit`, calling `executeTool` filled
the field with the supplied value (`amount` became `5000`) and then left
the promise pending. It did not submit. The call was still outstanding
when the probe timed out.

With `toolautosubmit`, the form submits without a human.

**Consequence for both designs.** Declarative WebMCP has a native
human-in-the-loop gate, and it implements that gate by holding the tool
call open. That is the opposite of AgentDesk's rule that a consequential
call returns `APPROVAL_REQUIRED` immediately and never blocks a WebMCP
promise. The two models cannot both own the approval boundary for the same
action, so a design has to pick one per capability rather than layering
them. `docs/design/browser-extension.md` resolves this.

## Re-running these

The probes were plain `evaluate` calls against a page with WebMCP
available. Load `/p0/`, confirm the banner reads "WebMCP native: YES",
then inject a form carrying `toolname` and query `getTools()`. Avoid
executing a non-autosubmit form from an automated probe; the promise will
not settle without a human click and will hang the runner.
