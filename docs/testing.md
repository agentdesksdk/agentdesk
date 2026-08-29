# Testing

## Automated

```bash
pnpm install
pnpm test        # SDK (142) + P0 startup (4) + demo (96)
pnpm typecheck   # strict TS across all packages
pnpm build       # SDK build + P0 + demo static build + site assembly
pnpm test:pack   # packs the SDK and imports it under plain Node
```

Coverage highlights (see `packages/webmcp/tests` and `apps/demo/tests`):

- runtime lifecycle: bootstrap registration, idempotent `start()`, listener
  removal does not unregister tools
- native dynamic routing: activation, reconciliation, aborts, unrelated tools
  stay unregistered
- compatibility path: `invoke_capability` and native calls hit the same
  handler, policy, and audit pipeline
- availability: reason codes, suggested alternatives, execution-time
  re-check rejects a previously-available capability
- approval: immediate `APPROVAL_REQUIRED`, no handler before approval,
  fail-closed re-check, zero-side-effect reject, observable status
- dead tools: tombstoned calls return structured `TOOL_RETIRED` recovery
- audit: deterministic event sequence for the hero flow
- baseline: flat mode registers the whole catalog; routed mode registers
  bootstrap + working set; same handlers
- reset: seed state, refund state, pending approvals, and audit all restore
- architecture boundaries: source scans assert only the adapter touches
  `document.modelContext` and only ToolSurfaceManager calls the adapter

## Manual browser checks (P0 harness)

Local: `pnpm p0` then open the printed URL. Deployed: `<site>/p0/`.

The harness registers `get_context`, `find_capabilities`,
`invoke_capability`, and `get_action_status` at startup and shows live
counters for registrations, retirements/aborts, invocations, dynamic
registrations, and stale calls.

### ChatGPT in-app browser

1. Open the P0 page in ChatGPT's browser.
2. Ask the agent to list available tools. Expected: the four bootstrap
   tools only.
3. Ask it to call `find_capabilities` with query `hello`.
4. Verify `hello_dynamic_tool` appears under "Active tools" on the page.
5. Ask it to call `hello_dynamic_tool` with `{"name":"ChatGPT"}` in the same
   turn; note whether it sees the tool immediately or only after a refresh.
6. Click **Retire dynamic tool**.
7. Ask it to call `hello_dynamic_tool` again. Expected: structured
   `TOOL_RETIRED` with recovery instructions (stale-client test).
8. Click **Re-register dynamic tool**; ask it to call the tool again.
9. Ask it to call `invoke_capability` with `{"name":"ping"}`. Expected:
   `pong` regardless of tool-list staleness.
10. Ask it to call `request_demo_approval`. Expected: immediate
    `APPROVAL_REQUIRED` with an `approval_id` (no hanging call). Approve on
    the page, then ask it to call `get_action_status` with that id.

### Chrome (WebMCP flag)

Use Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled and an
agent surface that consumes `document.modelContext` (e.g. Gemini-in-Chrome
or a WebMCP-enabled extension client).

1. Open the P0 page; the banner should read "WebMCP native: YES".
2. Repeat steps 2–10 above with the Chrome agent surface.

### Harness readiness (automated, no WebMCP client)

Verified 2026-08-29 by driving the P0 page in a plain Chrome with no
WebMCP. This proves the harness is ready for the manual runs below; it
does not and cannot substitute for them.

| Behavior | Result |
| --- | --- |
| `hello_dynamic_tool` typed execution | `{"greeting":"Hello, Audit!","deterministic":true}` |
| Stale call after retire | `CAPABILITY_UNAVAILABLE` / `CAPABILITY_RETIRED` |
| Compatibility path `invoke_capability({name:"ping"})` | `pong` |
| `request_demo_approval` returns immediately | 1 pending, `get_action_status` → `PENDING` |
| Native tool list | empty, correctly reported as unsupported |

The last row is the point: native registration, retirement, and
re-registration are only observable in a browser that implements WebMCP.
That run has since been completed in the Codex in-app browser and is
recorded below.

### Results

Do not fill a cell without actually observing the behavior.

**Codex in-app browser: complete.** Native WebMCP was exposed at
`http://127.0.0.1:4177/p0/` and the full checklist ran there.

**Chrome 152: complete.** The same page was driven over CDP against a real
`document.modelContext`, covering the consumer surface (`getTools`,
`executeTool`) the Codex run did not reach. ChatGPT remains unverified;
nobody has run it.

| Test | Codex in-app browser | Chrome 152 | ChatGPT in-app browser |
| --- | --- | --- | --- |
| Bootstrap tools discovered | ✅ four bootstrap tools | ✅ four bootstrap tools | ⬜ |
| `find_capabilities({query:"hello"})` | ✅ registered `hello_dynamic_tool`, `ping`, `request_demo_approval` | ✅ `hello_dynamic_tool` added to the native surface | ⬜ |
| Dynamic call | ✅ `{"greeting":"Hello, Audit!","deterministic":true}` | ✅ via `executeTool`, `{"greeting":"Hello, Native!","deterministic":true}` | ⬜ |
| New native tool discovered immediately | ⚠️ registered immediately, callable after the client refreshed its tool snapshot | ✅ `getTools()` returned it in the same turn | ⬜ |
| Discovered on next turn | ✅ | ✅ | ⬜ |
| Retired tool behavior | ✅ structured `TOOL_RETIRED` | ✅ structured `CAPABILITY_UNAVAILABLE` / `CAPABILITY_RETIRED` | ⬜ |
| Same-name re-registration | ✅ `{"greeting":"Hello, Codex!","deterministic":true}` | ✅ re-registered under the same name | ⬜ |
| `invoke_capability` fallback | ✅ `invoke_capability({name:"ping"})` returned `pong` | ✅ returned `pong` | ⬜ |
| Approval flow | ✅ immediate `APPROVAL_REQUIRED`, `APR-1001` | ✅ immediate `APPROVAL_REQUIRED`, evidence `summary` | ⬜ |
| Approval status after approving | ✅ `APPROVED_EXECUTED` | ✅ handler ran only after approval | ⬜ |
| Browser console | ✅ no warnings or errors | ✅ no warnings or errors | ⬜ |
| `getTools()` | not exercised | ✅ 7 tools with `origin` `http://127.0.0.1:4177` | ⬜ |
| `executeTool()` | not exercised | ⚠️ requires a JSON **string**; a plain object throws | ⬜ |

### Chrome 152 divergence from the spec IDL

Observed 2026-08-29 on Chrome 152.0.0.0 (Windows) at
`http://127.0.0.1:4177/p0/`, with `registerTool`, `getTools`, and
`executeTool` all present.

The spec types `executeTool`'s second argument as `object inputObject` and
serializes it internally. Chrome 152 rejects an object:

```text
executeTool(tool, {})                        → UnknownError: Failed to parse input arguments
executeTool(tool, undefined)                 → UnknownError: Failed to parse input arguments
executeTool(tool, "{}")                      → {"content":[{"type":"text","text":"pong"}]}
executeTool(tool, '{"name":"Native"}')       → {"content":[{"type":"text","text":"{\"greeting\":\"Hello, Native!\"…
```

`createWebMcpClient` serializes input to a JSON string and learns the
encoding from the first call. The fallback to the object form fires only
on a rejection that provably happened before the tool ran, matched on the
argument-format signature above. Any other failure means parsing
succeeded and the handler may already have committed, so retrying could
duplicate a write; the client returns the failure instead and remembers
that the string form is correct. It never retries after an abort, and a
caller who supplies their own string gets their error verbatim.

Verified end to end in Chrome 152 through `window.agentdeskClient` on the
P0 page: `getTools()` returned all seven registered tools, and
`callTool(hello_dynamic_tool, {name: "Client"})` returned
`{"greeting":"Hello, Client!","deterministic":true}` on both the first
call and a repeat that used the learned encoding. Circular and BigInt
input return `{ok: false, reason}` rather than rejecting the promise.

Observed wording for the submission, matching the Codex column. AgentDesk
dynamically updates the native WebMCP surface, with client rediscovery
occurring when the client refreshes its tool snapshot, typically the next
turn. `invoke_capability` covers clients whose discovery lags behind the
page.

### Hero flow (demo app)

1. Open `/agentdesk` and connect a WebMCP client.
2. Prompt: *Find Alice Johnson's unshipped order. If she paid shipping,
   refund the shipping fee. Do not perform the refund without my approval.*
3. Watch the inspector: 78 → ≤6 routed tools after `find_capabilities`.
4. The refund returns `APPROVAL_REQUIRED`; the approval card shows order
   #10428, Alice Johnson, $18.00.
5. Approve. Order #10428's shipping shows "Refunded", Billing shows a
   credit, the activity timeline shows the full sequence.
6. Click **Reset Demo** and verify pristine state.

Without a WebMCP client you can drive the same flow from the console
(`window.agentdesk`) or the inspector's "Route a task" box; the routing,
approval, and audit behavior is identical because both paths share one
pipeline.
