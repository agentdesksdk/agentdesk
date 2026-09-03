// Stub. The tests in scripts/evals/test/routing-holdout-2.test.mjs were
// written against these exports first; every answer here is wrong on
// purpose, so the tests fail on their assertions and not on an import.
export const name = "hierarchical-near-tie-1.0";
export const NEAR_TIE = 0.75;

export function tiedDomains(ranked, threshold = NEAR_TIE) {
  void threshold;
  return ranked.map((entry) => entry.domain);
}

export default function scorer(candidates) {
  return candidates.map((c) => ({ name: c.name, score: 1, reasons: ["stub"] }));
}
