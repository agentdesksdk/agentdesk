import type { AppContext, Capability } from "./capability.ts";
import type { CapabilityCatalog } from "./catalog.ts";

export type RouteError = {
  kind: "unknown_capability";
  name: string;
};

export function routeCapability(
  catalog: CapabilityCatalog,
  name: string,
): Capability | RouteError {
  const capability = catalog.get(name);
  if (!capability) {
    return { kind: "unknown_capability", name };
  }
  return capability;
}

export function isRouteError(
  value: Capability | RouteError,
): value is RouteError {
  return "kind" in value && value.kind === "unknown_capability";
}

export type RankedCapability = {
  capability: Capability;
  score: number;
};

export const ROUTING_WEIGHTS = {
  intent: 5,
  domain: 4,
  entity: 3,
  keyword: 2,
  route: 1,
} as const;

export const MAX_ROUTED = 6;
export const DEFAULT_ROUTED = 5;

/**
 * Deterministic context-aware scoring. No embeddings. A capability is
 * relevant when the task phrasing matches its intents/keywords, or the
 * current application context (route, domain, focused entities) points
 * at it. Zero-score capabilities are never routed.
 */
export function rankCapabilities(
  capabilities: readonly Capability[],
  ctx: AppContext,
  query: string,
  limit: number = DEFAULT_ROUTED,
): RankedCapability[] {
  const tokens = new Set(tokenize(query));
  const contextDomain =
    typeof ctx.state.domain === "string" ? ctx.state.domain : undefined;

  const ranked: RankedCapability[] = [];
  for (const capability of capabilities) {
    let score = 0;
    if (
      tokens.size > 0 &&
      capability.intents.some((intent) =>
        tokenize(intent).every((word) => tokens.has(word)),
      )
    ) {
      score += ROUTING_WEIGHTS.intent;
    }
    if (capability.domain !== undefined) {
      const domainToken = stem(capability.domain.toLowerCase());
      if (tokens.has(domainToken) || contextDomain === capability.domain) {
        score += ROUTING_WEIGHTS.domain;
      }
    }
    if (
      capability.entities.some(
        (key) => ctx.state[key] !== undefined && ctx.state[key] !== null,
      )
    ) {
      score += ROUTING_WEIGHTS.entity;
    }
    const keywordHits = capability.keywords.filter((keyword) =>
      tokens.has(stem(keyword.toLowerCase())),
    ).length;
    if (keywordHits > 0) {
      score += ROUTING_WEIGHTS.keyword * Math.min(keywordHits, 2);
    }
    if (capability.routes.some((prefix) => routeMatches(ctx.route, prefix))) {
      score += ROUTING_WEIGHTS.route;
    }
    if (score > 0) {
      ranked.push({ capability, score });
    }
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score || a.capability.name.localeCompare(b.capability.name),
  );
  return ranked.slice(0, Math.min(limit, MAX_ROUTED));
}

/** "/" is the exact root route, not a universal prefix. */
function routeMatches(currentRoute: string, prefix: string): boolean {
  if (prefix === "/") {
    return currentRoute === "/";
  }
  return currentRoute.startsWith(prefix);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .map(stem);
}

/** Light plural folding so "orders" matches "order". Not a stemmer. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}
