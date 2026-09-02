/**
 * The leakage rule, as a number.
 *
 * The held-out tasks are authored from what a person knows about a
 * capability, its name and what it does, and not from the intents and
 * keywords the scorer reads. Trust does not enforce that; this does. The
 * figure is the share of a prompt's content tokens that appear in the
 * expected capability's routing metadata, tokenized the way the router
 * tokenizes, so a prompt that quotes an intent scores 1 and is refused.
 */
export const OVERLAP_THRESHOLD = 0.5;

/** Function words that carry no vocabulary; they leave the denominator. */
export const STOPWORDS = Object.freeze([
  "the", "a", "an", "and", "or", "but", "if", "so", "as", "of", "on", "in", "at", "to", "for", "from", "by",
  "with", "into", "about", "than", "then", "that", "this", "these", "those", "it", "its", "is", "are", "was",
  "were", "be", "been", "being", "has", "have", "had", "do", "does", "did", "can", "could", "would", "should",
  "will", "may", "might", "must", "i", "me", "my", "we", "us", "our", "you", "your", "they", "them", "their",
  "there", "here", "what", "which", "who", "whom", "how", "when", "where", "why", "please", "just", "also",
  "still", "again", "not", "no", "yes", "any", "some", "all", "one", "up", "out", "off", "over", "im", "ive",
  // What the router's tokenizer leaves behind from a contraction.
  "t", "s", "d", "ll", "re", "ve", "m",
]);
const STOP = new Set(STOPWORDS);

/** Every token routing scores on for a capability: name, intents, keywords, domain. */
export function metadataTokens(spec, tokenize) {
  const tokens = new Set();
  const add = (text) => {
    for (const token of tokenize(text)) tokens.add(token);
  };
  add(spec.name.split("_").join(" "));
  for (const intent of spec.intents ?? []) add(intent);
  for (const keyword of spec.keywords ?? []) add(keyword);
  if (typeof spec.domain === "string") add(spec.domain);
  return tokens;
}

/**
 * Content tokens are the prompt's tokens without stopwords and without
 * bare numbers: an order id is not vocabulary, and counting it would let
 * "refund 10428" pass as half-original.
 */
export function tokenOverlap(prompt, spec, tokenize) {
  const promptTokens = [...new Set(tokenize(prompt))].filter((t) => !STOP.has(t) && !/^\d+$/.test(t));
  const meta = metadataTokens(spec, tokenize);
  const matched = promptTokens.filter((t) => meta.has(t));
  return {
    ratio: promptTokens.length === 0 ? 0 : matched.length / promptTokens.length,
    matched,
    promptTokens,
  };
}
