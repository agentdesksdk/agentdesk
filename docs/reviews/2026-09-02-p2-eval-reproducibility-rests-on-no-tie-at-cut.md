# P2: eval reproducibility rests on the routed set never being truncated

Status: **RESOLVED**

Reviewed `origin/main` at `87e6d6e` (PR #14). Tracked as issue #19.

## Finding

`visibleToolCount` and `registeredSchemaBytes` follow which capabilities
route, and routing broke ties with a locale-sensitive comparator. Every
reference task scores fewer capabilities than the budget, so no tie is ever
broken and the numbers were locale-stable, but one more matching capability
or a tighter budget would have made `registeredSchemaBytes` vary by host.

## Required correction

Take the comparator fix, and state the dependency in `docs/evaluations.md`.

## Regression requirement

None beyond the locale suite that covers the comparator.

## Resolution

The tie-break is codepoint order, so a tie at the cut resolves identically
on every host. `docs/evaluations.md` records the dependency and that the
reference run currently has no tie at the cut.
