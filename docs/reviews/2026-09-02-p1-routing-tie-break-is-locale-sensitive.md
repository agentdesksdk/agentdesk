# P1: the routing tie-break is locale-sensitive, so the published tool surface varies by user

Status: **RESOLVED**

Reviewed `origin/main` at `87e6d6e` (PR #12). Tracked as issue #15.

## Finding

Routing ties break on `localeCompare` with no locale argument, in `scoreAll`
on the live `rankCapabilities` path and in `order` on the V2 path. With no
locale the comparison resolves against the host default, which in a browser
is the user's locale. Seven capabilities tied at score 2 with a budget of 6:

```text
BUDGET6_EN  aardvark_task,ds_task,ee_task,ff_task,gg_task,hh_task  | dropped: zz_task
BUDGET6_DA  ds_task,ee_task,ff_task,gg_task,hh_task,zz_task        | dropped: aardvark_task
```

Danish collates a leading `aa` as `å`, after `z`. A brute force over the
alphabet `NAME_RE` permits disagreed with codepoint order on 13,357 of
199,994 random pairs across twelve locales. This contradicts the guarantee
the code and `docs/routing.md` state, that equal scores never reorder.

Two further sites sorted the same way and were found during the fix: the
no-match fallback in `findCapabilities`, which sorts by name and offers the
first five, and `fingerprintInput`, which sorts object keys to build the
idempotency key.

## Required correction

Compare codepoints at every site. Names are ASCII by construction, so
codepoint order is the natural order and is identical on every host.

## Regression requirement

A tied set including a name beginning `aa` and one beginning `zz`, asserting
the routed order equals a codepoint sort and is identical when the comparator
is evaluated under `en`, `da`, `et`, and `lt` explicitly. Asserting only under
the host default passes on a US machine and proves nothing.

## Resolution

`compareNames` in `router.ts` compares codepoints and replaces all four
`localeCompare` calls. Covered by `packages/webmcp/tests/routing-locale.test.ts`,
which patches `String.prototype.localeCompare` with an explicit collator per
locale and asserts `rankCapabilities`, `routeTask` under both strategies, and
the no-match fallback all hand back the codepoint prefix. Three of its cases
fail against the previous comparator. The fingerprint has no external
observation point and is covered by the same helper.
