# Testing

## Automated

```bash
pnpm install
pnpm test        # SDK (28 tests) + demo (10 tests)
pnpm typecheck   # strict TS across all packages
pnpm build       # SDK typecheck + P0 + demo static build + site assembly
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

### Results

Do not fill a cell without actually observing the behavior. Observed
2026-08-28 against the local build; Codex column from a live Codex in-app
browser session.

| Test | Codex in-app browser | ChatGPT in-app browser | Chrome 149+ WebMCP |
| --- | --- | --- | --- |
| Bootstrap tools discovered | ✅ four bootstrap tools listed | ⬜ | ⬜ |
| `find_capabilities` works | ✅ routed and activated tools | ⬜ | ⬜ |
| New native tool discovered immediately | ⚠️ registered immediately, callable only after the client refreshed its tool snapshot | ⬜ | ⬜ |
| Discovered on next turn | ✅ | ⬜ | ⬜ |
| Retired tool behavior | ✅ stale call returned structured `TOOL_RETIRED` | ⬜ | ⬜ |
| Same-name re-registration | ✅ after snapshot refresh (`Hello, ChatGPT!`) | ⬜ | ⬜ |
| `invoke_capability` fallback | ✅ (`pong`) | ⬜ | ⬜ |
| Approval flow | ✅ immediate `APPROVAL_REQUIRED`; `APR-1001` resolved `APPROVED_EXECUTED` | ⬜ | ⬜ |

Observed wording for the submission (matches the Codex column): AgentDesk
dynamically updates the native WebMCP surface, with client rediscovery
occurring when the client refreshes its tool snapshot (typically the next
turn); `invoke_capability` covers clients whose discovery lags behind the
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
