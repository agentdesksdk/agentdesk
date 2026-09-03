// The hierarchical domain step with its near-tie at 1.0: only a domain
// that ties the top one exactly is kept, so the second domain the SDK
// keeps at its default of 0.75 is gone. Run beside the default as
//
//   node scripts/evals/routing/run.mjs --seed 7 \
//     --tasks scripts/evals/routing/tasks/routing.v2.tasks.jsonl \
//     --strategies deterministic \
//     --scorer scripts/evals/routing/scorers/hierarchical-near-tie-1.mjs
//
// `NEAR_TIE` is a constant inside the SDK, not a parameter, so this is
// composed from what the SDK exports: the catalog tree ranks the domains,
// the candidates are restricted to the ones that tie the top, and the
// SDK's own `hierarchicalScorer` ranks inside them. It reads the built
// package, so run `pnpm build` first.
//
// Composition is not the constant. When no second domain nearly ties at
// the default, the SDK scorer would keep one domain either way, so it is
// called over the whole catalog and the result is its own, byte for byte.
// Only when a second domain nearly ties is the candidate set restricted
// to what 1.0 keeps, and inside that set the SDK scorer folds the query's
// tokens to those members' vocabulary rather than the whole catalog's,
// and with two exactly tied domains applies its own near-tie over the
// pair. Both residual differences are named here so the ablation is read
// as what it is.
import { catalogHierarchy, hierarchicalScorer } from "../../../../packages/webmcp/dist/index.js";

export const name = "hierarchical-near-tie-1.0";

/** The SDK's default, restated so the ablation says what it changes. */
export const NEAR_TIE = 0.75;

/** Where a capability with no domain lives in the tree, as hierarchy.ts spells it. */
const UNCATEGORIZED = "uncategorized";

/**
 * The domains kept from a ranking: the top one, and the second when it
 * scores at least `threshold` of the top, which is the SDK's rule with
 * the threshold made explicit. At 1.0 the second survives only an exact
 * tie. Never a third; the SDK keeps at most two.
 */
export function tiedDomains(ranked, threshold = NEAR_TIE) {
  const top = ranked[0];
  if (top === undefined) {
    return [];
  }
  return ranked
    .filter((entry, index) => index === 0 || (index === 1 && entry.score >= threshold * top.score))
    .map((entry) => entry.domain);
}

export default function scorer(candidates, request) {
  const hierarchy = catalogHierarchy(candidates);
  const ranked = hierarchy.rankDomains(request.query, () => true, request.domain);
  const atDefault = tiedDomains(ranked, NEAR_TIE);
  const atOne = tiedDomains(ranked, 1.0);
  if (atDefault.length === atOne.length) {
    // No domain implied, or one domain either way: the SDK scorer gives
    // the same answer at 0.75 and at 1.0, so its answer is this one.
    return hierarchicalScorer(candidates, request);
  }
  const chosen = new Set(atOne);
  const members = candidates.filter((member) => chosen.has(member.domain ?? UNCATEGORIZED));
  return hierarchicalScorer(members, request);
}
