// Stub. The tests in scripts/evals/test/routing-scorers.test.mjs were
// written against these exports first; every answer here is wrong on
// purpose, so the tests fail on their assertions and not on an import.
export const BUILTIN_STRATEGIES = Object.freeze(["deterministic", "hybrid"]);

export function resolveStrategy(name) {
  void name;
  return { name: "deterministic", kind: "deterministic", strategy: { kind: "deterministic" } };
}

export async function loadScorer(path, options = {}) {
  void path;
  void options;
  return { name: "custom:stub", kind: "deterministic", strategy: { kind: "deterministic" }, path: "" };
}

export async function resolveStrategies(options = {}) {
  void options;
  return [];
}

export function recordsFileKey(name) {
  return name;
}
