// Stub. See schema.mjs.
export const DOMAINS = Object.freeze([]);

export function generateCatalog(seed = 2026) {
  return { seed, domains: [], specs: [] };
}

export function buildRoutingCatalog(defineCapability, seed = 2026) {
  void defineCapability;
  return { seed, specs: [], capabilities: [] };
}
