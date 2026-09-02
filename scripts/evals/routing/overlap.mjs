// Stub. See schema.mjs.
export const OVERLAP_THRESHOLD = 1;
export const STOPWORDS = Object.freeze([]);

export function metadataTokens(spec, tokenize) {
  void spec;
  void tokenize;
  return new Set();
}

export function tokenOverlap(prompt, spec, tokenize) {
  void prompt;
  void spec;
  void tokenize;
  return { ratio: 0, matched: [], promptTokens: [] };
}
