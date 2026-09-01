# P2: `fromOrigins` is advisory and nothing says so

Status: **RESOLVED**

Reviewed `origin/main` at `87e6d6e` (PR #13). Tracked as issue #17.

## Finding

`listTools` forwards `fromOrigins` to the provider and returns the answer
unverified. Against a provider that ignores the filter:

```text
listTools({ fromOrigins: ["https://app.example"] })
ORIGINS_RETURNED  https://app.example,https://evil.example
```

Under a browser that is correct, because the browser enforces it. Under
MCP-B's polyfill the provider is page or extension script, so `fromOrigins`
is a request made to an untrusted party. The conformance table in
`docs/architecture.md` listed it with no caveat.

## Required correction

A contract statement, not code. Filtering client-side on `tool.origin` or
`RegisteredTool.window` would be security theatre, because the same provider
supplies those values.

## Regression requirement

None. This is a documentation contract with no behaviour change.

## Resolution

`docs/mcp-b-interop.md` states that enforcement lives in the provider, that a
polyfill provider is not a security boundary, and that `fromOrigins` is a
routing convenience that must never gate a decision. The conformance row in
`docs/architecture.md` carries the caveat.
